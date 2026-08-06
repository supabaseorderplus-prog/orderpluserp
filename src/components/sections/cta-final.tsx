"use client";

import React from "react";
import { Phone, ArrowRight } from "lucide-react";

const CTAFinal = () => {
  return (
    <section className="relative py-24 lg:py-32 overflow-hidden" id="contact">
      <div className="absolute inset-0 bg-obsidian" />
      <div className="absolute inset-0 bg-gradient-to-br from-gold/[0.04] via-transparent to-gold/[0.04]" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="glass-card gold-border-glow p-12 lg:p-20 text-center relative overflow-hidden">
          {/* Background glow */}
          <div className="absolute top-0 left-1/2 w-[400px] h-[400px] bg-gold/[0.06] rounded-full blur-[100px] -translate-x-1/2 -translate-y-1/2" />

          <div className="relative">
            <h2 className="mb-5">
              Ready to <span className="gold-gradient">Protect</span> Your Building?
            </h2>
            <p className="text-silver/70 max-w-2xl mx-auto mb-10">
              Get in touch with our team for product recommendations, bulk pricing,
              or technical support. We are here to help you find the right solution.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href="tel:+919614866663"
                className="btn-gold inline-flex items-center gap-2 px-8 py-3.5 text-sm"
              >
                <Phone className="w-4 h-4" />
                Call +91 96148 66663
              </a>
              <a
                href="#products"
                className="btn-outline-gold inline-flex items-center gap-2 px-8 py-3.5 text-sm"
              >
                Browse Products
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>

            <div className="mt-12 flex flex-wrap items-center justify-center gap-8 text-sm text-silver/40">
              <span>ISO 9001 Certified</span>
              <span className="hidden sm:inline text-zinc-900/[0.1]">&middot;</span>
              <span>13+ Years in Business</span>
              <span className="hidden sm:inline text-zinc-900/[0.1]">&middot;</span>
              <span>Pan-India Delivery</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CTAFinal;
