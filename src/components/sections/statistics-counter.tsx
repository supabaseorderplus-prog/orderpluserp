"use client";

import React from "react";
import { Globe, Trophy, Shield, Zap } from "lucide-react";

const stats = [
  { value: "50+", label: "Countries Reached", icon: Globe },
  { value: "5,000+", label: "Projects Completed", icon: Trophy },
  { value: "13+", label: "Years of Experience", icon: Shield },
  { value: "100%", label: "Quality Guarantee", icon: Zap },
];

const StatisticsCounter = () => {
  return (
    <section className="relative py-20 lg:py-24 overflow-hidden">
      <div className="absolute inset-0 bg-obsidian-light" />
      <div className="absolute inset-0 bg-gradient-to-r from-gold/[0.03] via-transparent to-gold/[0.03]" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="glass-card gold-border-glow p-10 lg:p-14">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-12">
            {stats.map((stat, i) => (
              <div key={stat.label} className="text-center">
                <div className="icon-glass w-12 h-12 flex items-center justify-center mx-auto mb-4">
                  <stat.icon className="w-5 h-5 text-gold" />
                </div>
                <p className="text-3xl lg:text-4xl font-display font-bold gold-gradient mb-1">
                  {stat.value}
                </p>
                <p className="text-sm text-silver/60 font-medium">{stat.label}</p>
                {i < stats.length - 1 && (
                  <div className="hidden lg:block absolute" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default StatisticsCounter;
