"use client";

import React from "react";
import Image from "next/image";
import { Star, ArrowRight } from "lucide-react";

const products = [
  {
    id: 1,
    name: "Bond Power XL",
    description:
      "Our strongest bonding polymer. Industrial-grade adhesion rated for 10+ years of performance in all weather conditions.",
    image:
      "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/render/image/public/project-uploads/63145925-7249-4723-ab4f-2bd2de2c6582/home-tech-5-1769700233801.jpeg?width=600&height=600&resize=contain",
    badge: "Best Seller",
    category: "SBR Polymer",
  },
  {
    id: 2,
    name: "Elite Guard",
    description:
      "Advanced damp-proofing compound that penetrates deep into concrete pores to eliminate moisture permanently.",
    image:
      "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/render/image/public/project-uploads/63145925-7249-4723-ab4f-2bd2de2c6582/home-tech-1769700233720.jpeg?width=600&height=600&resize=contain",
    badge: "Popular",
    category: "Damp Proof",
  },
  {
    id: 3,
    name: "Super Plasticizer",
    description:
      "High-range water reducer that triples cement strength without adding weight. Improves concrete workability.",
    image:
      "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/render/image/public/project-uploads/63145925-7249-4723-ab4f-2bd2de2c6582/home-tech-3-1769700234574.jpeg?width=600&height=600&resize=contain",
    badge: "Pro Choice",
    category: "Admixture",
  },
];

export default function PopularProducts() {
  return (
    <section className="relative py-24 lg:py-32 overflow-hidden" id="products">
      <div className="absolute inset-0 bg-obsidian" />
      <div className="absolute top-1/2 left-1/2 w-[700px] h-[700px] bg-gold/[0.02] rounded-full blur-[150px] -translate-x-1/2 -translate-y-1/2" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-4 mb-16">
          <div>
            <div className="section-badge mb-6">Featured Products</div>
            <h2>
              Our <span className="gold-gradient">Top Products</span>
            </h2>
          </div>
          <a
            href="#"
            className="inline-flex items-center gap-2 text-sm font-semibold text-gold hover:gap-3 transition-all duration-300"
          >
            View All Products <ArrowRight className="w-4 h-4" />
          </a>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {products.map((product) => (
            <div key={product.id} className="glass-card-hover overflow-hidden group">
              <div className="relative aspect-square bg-obsidian-lighter overflow-hidden">
                <Image
                  src={product.image}
                  alt={product.name}
                  fill
                  className="object-contain p-6 group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute top-4 left-4">
                  <span className="btn-gold px-3 py-1 text-xs !shadow-none">
                    {product.badge}
                  </span>
                </div>
                <div className="absolute top-4 right-4 glass-card px-3 py-1 text-xs font-medium text-platinum/70">
                  {product.category}
                </div>
              </div>

              <div className="p-6">
                <h3 className="font-display text-lg font-bold text-foreground mb-2 group-hover:text-gold transition-colors duration-300">
                  {product.name}
                </h3>
                <p className="text-sm text-silver/60 mb-4 leading-relaxed">
                  {product.description}
                </p>

                <div className="flex items-center justify-between pt-4 border-t border-black/[0.06]">
                  <div className="flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <Star key={i} className="w-4 h-4 text-gold fill-current" />
                    ))}
                    <span className="ml-2 text-xs text-silver/50">4.9</span>
                  </div>
                  <a
                    href="#contact"
                    className="text-sm font-semibold text-gold hover:text-gold-light transition-colors"
                  >
                    Enquire
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 glass-card gold-border-glow p-8 lg:p-10 flex flex-col lg:flex-row items-center justify-between gap-6">
          <div>
            <h3 className="font-display text-xl font-bold text-foreground mb-1">
              Need Bulk Pricing?
            </h3>
            <p className="text-silver/60 text-sm">
              Contractors and dealers get direct factory pricing. Contact us for wholesale rates.
            </p>
          </div>
          <a
            href="#contact"
            className="btn-gold inline-flex items-center gap-2 px-6 py-3 text-sm shrink-0"
          >
            Get Wholesale Rates
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
