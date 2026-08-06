"use client";

import React from "react";
import { Award, FlaskConical, Users, TrendingUp } from "lucide-react";

export default function AboutSection() {
  const highlights = [
    { icon: Award, title: "ISO 9001 Certified", desc: "Meeting international quality standards across all product lines." },
    { icon: FlaskConical, title: "Proprietary Formulas", desc: "R&D-backed formulations engineered for Indian climate conditions." },
    { icon: Users, title: "5,000+ Projects", desc: "Trusted by contractors, builders, and homeowners across India." },
    { icon: TrendingUp, title: "13+ Years Experience", desc: "Over a decade of expertise in construction chemical manufacturing." },
  ];

  return (
    <section className="relative py-24 lg:py-32 overflow-hidden" id="about">
      <div className="absolute inset-0 bg-obsidian-light" />
      <div className="absolute top-1/2 left-0 w-[500px] h-[500px] bg-gold/[0.02] rounded-full blur-[120px] -translate-y-1/2 -translate-x-1/2" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          <div>
            <div className="section-badge mb-6">About HomeTech</div>
            <h2 className="mb-6">
              Built on Science,{" "}
              <span className="gold-gradient">Driven by Results</span>
            </h2>
            <div className="space-y-4">
              <p className="text-silver leading-relaxed">
                Founded in 2013, HomeTech Chemical has grown from a small Kolkata-based
                lab into one of Eastern India&apos;s most trusted construction chemical
                manufacturers. We specialize in waterproofing compounds, bonding agents,
                and concrete admixtures.
              </p>
              <p className="text-silver leading-relaxed">
                Our products are formulated specifically for the Indian subcontinent&apos;s
                demanding climate - from monsoon-grade waterproofing to heat-resistant
                sealants. Every batch undergoes rigorous quality testing before it leaves
                our facility.
              </p>
            </div>

            <div className="mt-10 flex items-center gap-6 pt-8 border-t border-black/[0.06]">
              <div>
                <p className="text-2xl font-display font-bold text-foreground">Sahil Kumar</p>
                <p className="text-sm text-gold/70">Founder & Director</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {highlights.map((item) => (
              <div key={item.title} className="glass-card-hover p-6">
                <div className="icon-glass w-12 h-12 flex items-center justify-center mb-5">
                  <item.icon className="w-5 h-5 text-gold" />
                </div>
                <h4 className="font-display font-semibold text-foreground mb-2">{item.title}</h4>
                <p className="text-sm text-silver/70 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
