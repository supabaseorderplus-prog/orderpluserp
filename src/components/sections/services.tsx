"use client";

import React from "react";
import { Droplet, Sparkles, Shield, Leaf, CheckCircle2 } from "lucide-react";

const services = [
  {
    id: "waterproofing",
    icon: Droplet,
    title: "Waterproofing",
    description:
      "SBR polymer-based solutions that create a flexible, durable barrier against water ingress. Rated for 10+ years.",
    points: ["100% Leak Proof", "Weather Resistant", "UV Protected"],
  },
  {
    id: "admixtures",
    icon: Sparkles,
    title: "Cement Admixtures",
    description:
      "Concrete additives that enhance bonding strength, reduce shrinkage, and improve workability of cement mixes.",
    points: ["Triple Strength", "Anti-Crack Formula", "Zero Shrinkage"],
  },
  {
    id: "dampproof",
    icon: Shield,
    title: "Damp Proofing",
    description:
      "Deep-penetrating damp-proof compounds that eliminate moisture at the source. Prevents saltpeter and mold growth.",
    points: ["Moisture Barrier", "Mold Prevention", "Deep Penetration"],
  },
  {
    id: "eco",
    icon: Leaf,
    title: "Eco Solutions",
    description:
      "Environmentally conscious formulations that deliver industrial performance without toxic chemicals. Safe for homes.",
    points: ["Non-Toxic", "Green Certified", "Family Safe"],
  },
];

export default function ServicesSection() {
  return (
    <section className="relative py-24 lg:py-32 overflow-hidden" id="services">
      <div className="absolute inset-0 bg-obsidian-light" />
      <div className="absolute bottom-0 right-0 w-[600px] h-[600px] bg-gold/[0.02] rounded-full blur-[120px] translate-y-1/2 translate-x-1/4" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mb-16">
          <div className="section-badge mb-6">Our Solutions</div>
          <h2 className="mb-5">
            Comprehensive <span className="gold-gradient">Chemical Solutions</span>
          </h2>
          <p className="text-silver">
            From waterproofing to eco-friendly formulations, we offer a complete
            range of construction chemicals engineered for the Indian market.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {services.map((service) => (
            <div key={service.id} className="glass-card-hover p-6 group">
              <div className="icon-glass w-12 h-12 flex items-center justify-center mb-5 group-hover:shadow-[0_0_20px_rgba(201,168,76,0.15)] transition-shadow duration-500">
                <service.icon className="w-6 h-6 text-gold" />
              </div>

              <h3 className="font-display text-lg font-bold text-foreground mb-2">
                {service.title}
              </h3>
              <p className="text-sm text-silver/60 mb-5 leading-relaxed">
                {service.description}
              </p>

              <div className="space-y-2.5">
                {service.points.map((point) => (
                  <div key={point} className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald shrink-0" />
                    <span className="text-sm text-platinum/70">{point}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
