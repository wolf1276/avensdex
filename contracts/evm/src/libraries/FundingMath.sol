// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Port of NEARFlow packages/funding: signed division truncates toward zero.
/// @dev Pure controller math only; does not authorize updates or accrue collateral.
library FundingMath {
    int256 internal constant SCALE = 1_000_000;
    uint256 internal constant INTERVAL = 3600;
    uint256 internal constant MAX_PRICE = 1e27;

    enum Mode {
        BASELINE,
        ADAPTIVE
    }

    struct Params {
        int256 version;
        int256 cap_ppm;
        int256 step_ppm;
        int256 deadband_ppm;
        int256 smoothing_ppm;
        int256 ema_alpha_ppm;
        int256 nonlinear_scale_ppm;
        int256 max_premium_ppm;
        int256 oracle_max_age_sec;
        int256 mark_max_age_sec;
    }

    error InvalidParameters();
    error SignalOutsideBounds();
    error InvalidOrStaleSignal();

    function defaults() internal pure returns (Params memory) {
        return Params(1, 2000, 400, 200, 200_000, 500_000, 10_000, 100_000, 60, 300);
    }

    function validate(Params memory p) internal pure {
        if (
            p.version != 1 || p.cap_ppm < 1 || p.cap_ppm > 2000 || p.step_ppm < 1 || p.step_ppm > p.cap_ppm
                || p.deadband_ppm < 0 || p.deadband_ppm > 2000 || p.smoothing_ppm < 1 || p.smoothing_ppm > SCALE
                || p.ema_alpha_ppm < 1 || p.ema_alpha_ppm > SCALE || p.nonlinear_scale_ppm < 1000
                || p.nonlinear_scale_ppm > 100_000 || p.max_premium_ppm < 2000 || p.max_premium_ppm > 100_000
                || p.deadband_ppm >= p.max_premium_ppm || p.oracle_max_age_sec < 1 || p.oracle_max_age_sec > 60
                || p.mark_max_age_sec < 1 || p.mark_max_age_sec > 300
        ) revert InvalidParameters();
    }

    function premium(uint256 index, uint256 mark, uint256 indexAt, uint256 markAt, uint256 now_, Params memory p)
        internal
        pure
        returns (int256 sample)
    {
        validate(p);
        if (
            index == 0 || mark == 0 || index > MAX_PRICE || mark > MAX_PRICE || indexAt > now_ || markAt > now_
                || now_ - indexAt > uint256(p.oracle_max_age_sec) || now_ - markAt > uint256(p.mark_max_age_sec)
        ) revert InvalidOrStaleSignal();
        sample = (int256(mark) - int256(index)) * SCALE / int256(index);
        checkSignal(sample, p.max_premium_ppm);
    }

    function ema(int256 sample, int256 previous, bool initialized, Params memory p) internal pure returns (int256) {
        validate(p);
        checkSignal(sample, p.max_premium_ppm);
        if (!initialized) return sample;
        checkSignal(previous, p.max_premium_ppm);
        return previous + (sample - previous) * p.ema_alpha_ppm / SCALE;
    }

    function nextRate(Mode mode, int256 signal, int256 previous, Params memory p) internal pure returns (int256) {
        validate(p);
        checkSignal(signal, p.max_premium_ppm);
        checkSignal(previous, p.cap_ppm);
        if (mode == Mode.BASELINE) return clamp(signal, -p.cap_ppm, p.cap_ppm);
        int256 magnitude = signal < 0 ? -signal : signal;
        magnitude = magnitude > p.deadband_ppm ? magnitude - p.deadband_ppm : int256(0);
        int256 effective = signal < 0 ? -magnitude : magnitude;
        int256 target = clamp(effective + effective * magnitude / p.nonlinear_scale_ppm, -p.cap_ppm, p.cap_ppm);
        int256 smoothed = previous + (target - previous) * p.smoothing_ppm / SCALE;
        return clamp(clamp(smoothed, previous - p.step_ppm, previous + p.step_ppm), -p.cap_ppm, p.cap_ppm);
    }

    function checkSignal(int256 value, int256 bound) private pure {
        // Compare before negating so int256.min rejects without an overflow panic.
        if (value < -bound || value > bound) revert SignalOutsideBounds();
    }

    function clamp(int256 value, int256 low, int256 high) private pure returns (int256) {
        return value < low ? low : value > high ? high : value;
    }
}
