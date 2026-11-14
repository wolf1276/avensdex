"use client";

import { motion } from "framer-motion";

import { ParallaxSection, TextAscend, WordReveal } from "./MotionPrimitives";

export function Manifesto() {
  return (
    <motion.section
      className="manifesto"
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
    >
      <TextAscend as="h2" duration={1} stagger={0.12}>
        {"A clearer view of the market.\nA deliberate move, not a blind one."}
      </TextAscend>
      <ParallaxSection className="ghost-bars" speed={36} y={24} blur={10}>
        <div aria-hidden />
      </ParallaxSection>
      <div className="manifesto-copy">
        <WordReveal
          text="A trading interface should make its boundaries as clear as its prices. Know what you are looking at, what your order means, and which account you are using."
          stagger={0.012}
        />
        <WordReveal
          text="Avalanche Fuji (43113) is a validation venue, not a promise of execution or profit. Deposits stay paused until the owner qualifies the deployment; trading follows the on-chain readiness check. Use test funds only. Leveraged trading carries risk."
          stagger={0.009}
          delay={0.08}
        />
      </div>
    </motion.section>
  );
}
