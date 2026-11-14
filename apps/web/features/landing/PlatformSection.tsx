"use client";

import { motion } from "framer-motion";
import Link from 'next/link';
import { DEFAULT_MARKET_SYMBOL } from '@/config';

import { FadeIn, TextAscend, WordReveal } from "./MotionPrimitives";

export function PlatformSection() {
  return (
    <motion.section
      className="agent-section agent-framework"
      id="platform"
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.35 }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
    >
      <FadeIn y={28} duration={1.1} blur={10}>
        <TextAscend as="h2" stagger={0.12} duration={0.9}>
          {"Less switching tabs.\nMore seeing the trade."}
        </TextAscend>
      </FadeIn>
      <motion.div initial={{ opacity: 0, x: 18, filter: "blur(10px)" }} whileInView={{ opacity: 1, x: 0, filter: "blur(0px)" }} viewport={{ once: true }}>
        <WordReveal
          text="The chart, the book, the ticket, your activity. The terminal reads paired Fuji RPC providers at one pinned block and sends transactions only through your wallet. New orders unlock after the on-chain readiness check passes."
          stagger={0.012}
          blur={7}
        />
        <Link href={`/trade/${DEFAULT_MARKET_SYMBOL}`} prefetch={false}>Explore the terminal ↗</Link>
      </motion.div>
    </motion.section>
  );
}
