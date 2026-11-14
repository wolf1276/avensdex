"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import Link from 'next/link';
import { DEFAULT_MARKET_SYMBOL } from '@/config';

import { TextAscend, WordReveal } from "./MotionPrimitives";

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"]
  });
  const heroScale = useTransform(scrollYProgress, [0, 1], [1, 1.08]);
  const heroY = useTransform(scrollYProgress, [0, 1], ["0%", "5%"]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.85, 1], [1, 0.88, 0.68]);

  return (
    <motion.section
      ref={ref}
      className="agent-hero"
      id="home"
      initial={{ opacity: 0, y: 18, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div className="hero-parallax-bg" aria-hidden style={{ scale: heroScale, y: heroY, opacity: heroOpacity }} />
      <motion.div
        className="hero-copy"
      >
        <TextAscend as="h1" delay={0.16} stagger={0.11} duration={0.95}>
          {"Find your edge.\nKeep your\nflow."}
        </TextAscend>
        <WordReveal
          text="A perpetuals workspace connected to Avalanche Fuji. View the book, connect your injected browser wallet, and manage signed limit orders against the configured deployment. Test funds only; trading follows on-chain venue readiness."
          delay={0.48}
          stagger={0.022}
          className="hero-subcopy"
        />
        <motion.div
          className="hero-actions"
          initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.62, delay: 0.72, ease: [0.22, 1, 0.36, 1] }}
        >
          <Link href={`/trade/${DEFAULT_MARKET_SYMBOL}`} prefetch={false}>Open testnet terminal ↗</Link>
          <a href="#platform">Explore Avensdex</a>
        </motion.div>
      </motion.div>
      <div className="hero-field" aria-hidden>
        <span className="hero-silhouette" />
        <span className="hero-mesh" />
      </div>
    </motion.section>
  );
}
