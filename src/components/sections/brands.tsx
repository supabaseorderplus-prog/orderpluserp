"use client";

import React from "react";
import { Home, Zap, ShieldCheck, ArrowRight } from "lucide-react";

const brandData = [
  {
    id: "hometech",
    title: "HomeTech Elite",
    tagline: "Residential & Commercial",
    description:
      "Our signature collection for residential and commercial excellence. Engineered for those who demand the best in structural integrity.",
    icon: Home,
  },
  {
    id: "powertech",
    title: "PowerTech Industrial",
    tagline: "Heavy-Duty Applications",
    description:
      "High-performance chemical solutions for heavy industrial applications. Designed to withstand extreme environmental conditions.",
    icon: Zap,
  },
  {
    id: "eliteguard",
    title: "Elite Guard",
    tagline: "Protective Coatings",
    description:
      "Advanced protective coatings and molecular sealants. The final word in architectural preservation and long-term endurance.",
    icon: ShieldCheck,
  },
];

const Brands = () => {
  return (
    <section className="relative py-24 lg:py-32 overflow-hidden">
      <div className="absolute inset-0 bg-obsidian" />
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-emerald/[0.02] rounded-full blur-[120px] -translate-y-1/4 translate-x-1/4" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="section-badge mx-auto mb-6">Our Brands</div>
          <h2 className="mb-5">
            Three Brands, <span className="gold-gradient">One Standard</span>
          </h2>
          <p className="max-w-2xl mx-auto text-silver">
            A curated selection of specialized brands, each a master in its domain,
            unified by a single vision of construction excellence.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {brandData.map((brand) => (
            <div key={brand.id} className="glass-card-hover p-8 group">
              <div className="icon-glass w-14 h-14 flex items-center justify-center mb-6 group-hover:shadow-[0_0_20px_rgba(201,168,76,0.15)] transition-shadow duration-500">
                <brand.icon className="w-6 h-6 text-gold" />
              </div>

              <h3 className="font-display text-xl font-bold text-foreground mb-1">
                {brand.title}
              </h3>
              <p className="text-sm text-gold/70 font-medium mb-4">{brand.tagline}</p>
              <p className="text-sm text-silver/60 mb-6 leading-relaxed">
                {brand.description}
              </p>

              <a
                href="#"
                className="inline-flex items-center gap-2 text-sm font-semibold text-gold hover:gap-3 transition-all duration-300"
              >
                Learn More
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          ))}
        </div>

        <div className="mt-16 glass-card gold-border-glow p-8 flex flex-col md:flex-row items-center justify-center gap-8 md:gap-16 text-center">
          <div>
            <p className="text-3xl font-display font-bold text-foreground">3 Brands</p>
            <p className="text-sm text-silver/60 mt-1">One Standard of Excellence</p>
          </div>
          <div className="hidden md:block w-px h-12 bg-black/[0.08]"></div>
          <div>
            <p className="text-3xl font-display font-bold gold-gradient">13+ Years</p>
            <p className="text-sm text-silver/60 mt-1">Of Relentless Innovation</p>
          </div>
          <div className="hidden md:block w-px h-12 bg-black/[0.08]"></div>
          <a
            href="#products"
            className="btn-gold inline-flex items-center gap-2 px-6 py-3 text-sm"
          >
            Compare Solutions
          </a>
        </div>
      </div>
    </section>
  );
};

export default Brands;
