// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {FundingMath as F} from "../src/libraries/FundingMath.sol";

import {Vm} from "./TestVm.sol";

contract FundingMathTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Foundry JSON objects encode fields in alphabetical order.
    struct Vector {
        string mode;
        int256 premium;
        int256 previous;
        int256 rate;
    }

    function rate(F.Mode selected, int256 sample, int256 previous, F.Params memory p) external pure returns (int256) {
        return F.nextRate(selected, sample, previous, p);
    }

    function signal(uint256 index, uint256 mark, uint256 indexAt, uint256 markAt, uint256 now_, F.Params memory p)
        external
        pure
        returns (int256)
    {
        return F.premium(index, mark, indexAt, markAt, now_, p);
    }

    function smooth(int256 sample, int256 previous, bool initialized, F.Params memory p)
        external
        pure
        returns (int256)
    {
        return F.ema(sample, previous, initialized, p);
    }

    function testSharedRateVectors() public view {
        Vector[] memory vectors = abi.decode(vm.parseJson(read("vectors.json")), (Vector[]));
        require(vectors.length > 0, "missing vectors");
        for (uint256 i; i < vectors.length; i++) {
            Vector memory v = vectors[i];
            require(F.nextRate(mode(v.mode), v.premium, v.previous, F.defaults()) == v.rate, "rate mismatch");
        }
    }

    function testSharedTracesAndSignMirrors() public view {
        checkTraces(read("traces.json"));
        checkTraces(read("calibration-vectors.json"));
    }

    function checkTraces(string memory json) private view {
        uint256 count;
        for (; count < 64; count++) {
            string memory prefix = string.concat("$[", vm.toString(count), "]");
            if (!vm.keyExistsJson(json, prefix)) break;
            F.Params memory p = F.defaults();
            string[] memory keys = vm.parseJsonKeys(json, string.concat(prefix, ".params"));
            for (uint256 j; j < keys.length; j++) {
                setParam(p, keys[j], vm.parseJsonInt(json, string.concat(prefix, ".params.", keys[j])));
            }
            int256[] memory samples = vm.parseJsonIntArray(json, string.concat(prefix, ".samples"));
            int256[] memory expectedEma = vm.parseJsonIntArray(json, string.concat(prefix, ".ema"));
            int256[] memory rates = vm.parseJsonIntArray(json, string.concat(prefix, ".rates"));
            require(samples.length == rates.length && samples.length == expectedEma.length && samples.length > 0);
            F.Mode selected = mode(vm.parseJsonString(json, string.concat(prefix, ".mode")));
            for (int256 sign = -1; sign <= 1; sign += 2) {
                int256 previous = vm.parseJsonInt(json, string.concat(prefix, ".previous")) * sign;
                int256 memory_;
                for (uint256 i; i < samples.length; i++) {
                    memory_ = F.ema(samples[i] * sign, memory_, i != 0, p);
                    require(memory_ == expectedEma[i] * sign, "EMA mismatch");
                    previous = F.nextRate(selected, memory_, previous, p);
                    require(previous == rates[i] * sign, "trace rate mismatch");
                }
            }
        }
        require(count > 0 && count < 64, "missing or excessive traces");
    }

    function testFuzzCapsStepsAndSymmetry(int256 input, int256 prior, uint256 seed) public pure {
        F.Params memory p = F.defaults();
        p.cap_ppm = int256(seed % 2000) + 1;
        p.step_ppm = int256((seed / 2000) % uint256(p.cap_ppm)) + 1;
        p.deadband_ppm = int256((seed / 4_000_000) % 2000);
        p.smoothing_ppm = int256((seed / 8_000_000_000) % 1_000_000) + 1;
        p.ema_alpha_ppm = int256((seed / 8_000_000_000_000_000) % 1_000_000) + 1;
        p.nonlinear_scale_ppm = int256((seed / 8) % 99_001) + 1000;
        int256 sample = input % (p.max_premium_ppm + 1);
        int256 previous = prior % (p.cap_ppm + 1);
        int256 result = F.nextRate(F.Mode.ADAPTIVE, sample, previous, p);
        require(result >= -p.cap_ppm && result <= p.cap_ppm, "absolute cap");
        require(result - previous >= -p.step_ppm && result - previous <= p.step_ppm, "step cap");
        require(result == -F.nextRate(F.Mode.ADAPTIVE, -sample, -previous, p), "rate symmetry");
        int256 memory_ = F.ema(sample, 0, true, p);
        require(memory_ == -F.ema(-sample, 0, true, p), "EMA symmetry");
        require(
            F.nextRate(F.Mode.BASELINE, sample, previous, p) == -F.nextRate(F.Mode.BASELINE, -sample, -previous, p),
            "baseline symmetry"
        );
    }

    function testSignalBoundsAndFreshness() public {
        F.Params memory p = F.defaults();
        require(F.premium(100000, 100120, 100, 100, 101, p) == 1200);
        require(F.premium(100000, 99880, 100, 100, 101, p) == -1200);
        require(F.premium(100000, 99999, 100, 100, 160, p) == -10);
        require(F.ema(-1000, 1000, true, p) == 0);
        require(F.ema(1000, type(int256).min, false, p) == 1000);
        vm.expectRevert(F.InvalidOrStaleSignal.selector);
        this.signal(0, 1, 0, 0, 0, p);
        vm.expectRevert(F.InvalidOrStaleSignal.selector);
        this.signal(100, 100, 0, 0, 61, p);
        vm.expectRevert(F.InvalidOrStaleSignal.selector);
        this.signal(100, 100, 2, 2, 1, p);
        vm.expectRevert(F.InvalidOrStaleSignal.selector);
        this.signal(100, 100, 400, 1, 400, p);
        vm.expectRevert(F.InvalidOrStaleSignal.selector);
        this.signal(1e27 + 1, 100, 1, 1, 1, p);
        vm.expectRevert(F.SignalOutsideBounds.selector);
        this.signal(1, 1e27, 1, 1, 1, p);
        vm.expectRevert(F.SignalOutsideBounds.selector);
        this.rate(F.Mode.ADAPTIVE, type(int256).min, 0, p);
        vm.expectRevert(F.SignalOutsideBounds.selector);
        this.smooth(0, type(int256).max, true, p);
        vm.expectRevert(F.SignalOutsideBounds.selector);
        this.rate(F.Mode.BASELINE, 0, 2001, p);
    }

    function testEveryParameterRejectsInvalidBounds() public {
        string[10] memory keys = [
            "version",
            "cap_ppm",
            "step_ppm",
            "deadband_ppm",
            "smoothing_ppm",
            "ema_alpha_ppm",
            "nonlinear_scale_ppm",
            "max_premium_ppm",
            "oracle_max_age_sec",
            "mark_max_age_sec"
        ];
        for (uint256 i; i < keys.length; i++) {
            F.Params memory p = F.defaults();
            setParam(p, keys[i], -1);
            vm.expectRevert(F.InvalidParameters.selector);
            this.rate(F.Mode.ADAPTIVE, 0, 0, p);
            setParam(p, keys[i], type(int256).max);
            vm.expectRevert(F.InvalidParameters.selector);
            this.rate(F.Mode.ADAPTIVE, 0, 0, p);
        }
        F.Params memory conflicting = F.defaults();
        conflicting.deadband_ppm = 2000;
        conflicting.max_premium_ppm = 2000;
        vm.expectRevert(F.InvalidParameters.selector);
        this.rate(F.Mode.ADAPTIVE, 0, 0, conflicting);
    }

    function setParam(F.Params memory p, string memory key, int256 value) private pure {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("version")) p.version = value;
        else if (k == keccak256("cap_ppm")) p.cap_ppm = value;
        else if (k == keccak256("step_ppm")) p.step_ppm = value;
        else if (k == keccak256("deadband_ppm")) p.deadband_ppm = value;
        else if (k == keccak256("smoothing_ppm")) p.smoothing_ppm = value;
        else if (k == keccak256("ema_alpha_ppm")) p.ema_alpha_ppm = value;
        else if (k == keccak256("nonlinear_scale_ppm")) p.nonlinear_scale_ppm = value;
        else if (k == keccak256("max_premium_ppm")) p.max_premium_ppm = value;
        else if (k == keccak256("oracle_max_age_sec")) p.oracle_max_age_sec = value;
        else if (k == keccak256("mark_max_age_sec")) p.mark_max_age_sec = value;
        else revert("unknown fixture parameter");
    }

    function read(string memory file) private view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../../packages/funding/", file));
    }

    function mode(string memory name) private pure returns (F.Mode) {
        if (keccak256(bytes(name)) == keccak256("BASELINE")) return F.Mode.BASELINE;
        require(keccak256(bytes(name)) == keccak256("ADAPTIVE"), "invalid fixture mode");
        return F.Mode.ADAPTIVE;
    }
}
