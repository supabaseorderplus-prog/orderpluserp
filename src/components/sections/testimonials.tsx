"use client";

import React from "react";
import { Star, Quote } from "lucide-react";

const testimonials = [
  {
    id: 1,
    quote:
      "My roof hasn't leaked in 5 years since using HomeTech products. The quality speaks for itself.",
    name: "Rajesh Kumar",
    role: "Homeowner",
    location: "Malda, West Bengal",
  },
  {
    id: 2,
    quote:
      "I've tried all the major brands. Nothing matches HomeTech's bonding strength and consistency.",
    name: "Anita Sharma",
    role: "Architect",
    location: "Legacy Builds, Kolkata",
  },
  {
    id: 3,
    quote:
      "We used BondPower on a large factory project. The results exceeded our expectations completely.",
    name: "Vikram Singh",
    role: "Contractor",
    location: "Singh & Sons, Delhi",
  },
];

const TestimonialsSection = () => {
  return (
    <section className="relative py-24 lg:py-32 overflow-hidden" id="testimonials">
      <div className="absolute inset-0 bg-obsidian" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-gold/[0.02] rounded-full blur-[120px] translate-y-1/3 -translate-x-1/4" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="section-badge mx-auto mb-6">Testimonials</div>
          <h2>
            What Our <span className="gold-gradient">Clients Say</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {testimonials.map((t) => (
            <div key={t.id} className="glass-card-hover p-8">
              <div className="flex gap-0.5 mb-4">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="w-4 h-4 text-gold fill-current" />
                ))}
              </div>

              <Quote className="w-8 h-8 text-gold/15 mb-3" />

              <p className="text-platinum/80 mb-6 leading-relaxed">{t.quote}</p>

              <div className="pt-5 border-t border-black/[0.06]">
                <p className="font-display font-semibold text-foreground">{t.name}</p>
                <p className="text-sm text-silver/50">
                  {t.role} &middot; {t.location}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default TestimonialsSection;
