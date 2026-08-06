"use client";

import React from "react";
import Image from "next/image";
import { ArrowRight, ShieldCheck, Zap, Trophy, Beaker, LogIn } from "lucide-react";
import Link from "next/link";

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center pt-22 pb-20 overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-obsidian" />
      <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-gold/[0.03] rounded-full blur-[150px] -translate-y-1/3 translate-x-1/3" />
      <div className="absolute bottom-0 left-0 w-[600px] h-[600px] bg-gold/[0.02] rounded-full blur-[120px] translate-y-1/3 -translate-x-1/3" />
      
      {/* Grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: "linear-gradient(rgba(201,168,76,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(201,168,76,0.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          <div>
            <div className="section-badge mb-8">
              <Beaker className="w-4 h-4" />
              Trusted Since 2013
            </div>

            <h1 className="mb-6">
              Premium Construction{" "}
              <span className="gold-gradient">Chemicals</span> for Lasting
              Results
            </h1>

            <p className="text-lg text-silver mb-10 max-w-lg leading-relaxed">
              Industrial-grade waterproofing, bonding agents, and admixtures
              engineered to protect your buildings for decades. Trusted by 5,000+
              contractors across India.
            </p>

              <div className="flex flex-wrap gap-4 mb-14">
                <a
                  href="#products"
                  className="btn-gold inline-flex items-center gap-2 px-8 py-3.5 text-sm"
                >
                  Explore Products
                  <ArrowRight className="w-4 h-4" />
                </a>
                <a
                  href="#contact"
                  className="btn-outline-gold inline-flex items-center gap-2 px-8 py-3.5 text-sm"
                >
                  Contact Sales
                </a>
                <Link
                  href="/login"
                  className="btn-outline-gold inline-flex items-center gap-2 px-8 py-3.5 text-sm"
                >
                  <LogIn className="w-4 h-4" />
                  Admin Login
                </Link>
              </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
              {[
                { icon: ShieldCheck, label: "ISO Certified" },
                { icon: Zap, label: "Fast Drying" },
                { icon: Trophy, label: "10+ Year Life" },
                { icon: Beaker, label: "Lab Tested" },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-2.5">
                  <div className="icon-glass w-8 h-8 flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4 text-gold" />
                  </div>
                  <span className="text-sm font-medium text-platinum/80">
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="relative aspect-square max-w-lg mx-auto">
              {/* Glow behind image */}
              <div className="absolute inset-0 bg-gold/[0.06] rounded-3xl blur-xl scale-95" />
              <div className="relative glass-card overflow-hidden h-full flex items-center justify-center p-8 gold-border-glow deep-shadow">
                <Image
                  src="https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/render/image/public/project-uploads/63145925-7249-4723-ab4f-2bd2de2c6582/home-tech-5-1769700233801.jpeg?width=800&height=800&resize=contain"
                  alt="HomeTech Chemical Products"
                  fill
                  className="object-contain p-8"
                  priority
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
