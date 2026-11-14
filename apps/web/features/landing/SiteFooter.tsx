"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import Link from 'next/link';
import { DEFAULT_MARKET_SYMBOL } from '@/config';
import Image from 'next/image';

export function SiteFooter() {
  const [notice, setNotice] = useState("");

  return (
    <motion.footer
      className="agent-footer"
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="footer-brand">
        <div className="landing-wordmark"><Image src="/logo.svg" alt="" width={28} height={28} className="footer-logo" /><span>Avensdex</span></div>
        <h2>
          Your market.
          <br />
          Your next move.
        </h2>
      </div>
      <div className="footer-middle">
        <div>
          <p>Explore</p>
          <a href="#platform">Platform</a>
          <a href="#use-cases">Inside Avensdex</a>
          <Link href={`/trade/${DEFAULT_MARKET_SYMBOL}`} prefetch={false}>Fuji testnet exchange</Link>
        </div>
      </div>
      <form className="footer-newsletter" onSubmit={(event) => {
        event.preventDefault();
        setNotice("Preview only — no email is sent or stored.");
      }}>
        <label htmlFor="newsletter">Stay in the flow</label>
        <p>Newsletter preview only. This form does not send, store or subscribe your email.</p>
        <div>
          <input id="newsletter" type="email" placeholder="Enter your email..." required />
          <button type="submit">Preview signup</button>
        </div>
        <p role="status">{notice}</p>
      </form>
      <div className="footer-bottom">
        <span>Avensdex · Avalanche Fuji C-Chain (43113)</span>
        <span>Test funds only. Not mainnet. Not financial advice.</span>
      </div>
    </motion.footer>
  );
}
