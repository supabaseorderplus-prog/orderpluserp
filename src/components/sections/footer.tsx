"use client";

import React from "react";
import { Phone, Mail, MapPin, Facebook, Instagram, Youtube, Twitter } from "lucide-react";

const Footer = () => {
  return (
    <footer className="relative bg-obsidian-light border-t border-black/[0.06] pt-16 pb-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 mb-12">
          <div>
            <div className="flex items-center gap-3 mb-5">
              <div className="icon-glass w-10 h-10 flex items-center justify-center">
                <span className="gold-gradient font-display font-bold text-xl">H</span>
              </div>
              <span className="font-display text-xl font-bold text-foreground">HomeTech</span>
            </div>
            <p className="text-sm text-silver/50 leading-relaxed mb-6">
              Premium construction chemicals manufacturer based in Kolkata. Trusted
              by contractors and builders across India since 2013.
            </p>
            <div className="flex gap-3">
              {[Facebook, Instagram, Youtube, Twitter].map((Icon, i) => (
                <a
                  key={i}
                  href="#"
                  className="icon-glass w-9 h-9 flex items-center justify-center hover:shadow-[0_0_16px_rgba(201,168,76,0.15)] transition-all duration-300"
                >
                  <Icon className="w-4 h-4 text-silver/50 hover:text-gold transition-colors" />
                </a>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-display font-semibold mb-5 text-sm uppercase tracking-wider text-foreground">
              Quick Links
            </h4>
            <ul className="space-y-3">
              {["Products", "About Us", "Services", "Blog", "Contact"].map(
                (item) => (
                  <li key={item}>
                    <a
                      href="#"
                      className="text-sm text-silver/50 hover:text-gold transition-colors duration-300"
                    >
                      {item}
                    </a>
                  </li>
                )
              )}
            </ul>
          </div>

          <div>
            <h4 className="font-display font-semibold mb-5 text-sm uppercase tracking-wider text-foreground">
              Solutions
            </h4>
            <ul className="space-y-3">
              {[
                "Waterproofing",
                "Cement Admixtures",
                "Damp Proofing",
                "Eco Solutions",
                "Protective Coatings",
              ].map((item) => (
                <li key={item}>
                  <a
                    href="#"
                    className="text-sm text-silver/50 hover:text-gold transition-colors duration-300"
                  >
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-display font-semibold mb-5 text-sm uppercase tracking-wider text-foreground">
              Contact
            </h4>
            <ul className="space-y-4">
              <li className="flex gap-3">
                <div className="icon-glass w-8 h-8 flex items-center justify-center shrink-0">
                  <Phone className="w-3.5 h-3.5 text-gold" />
                </div>
                <span className="text-sm text-silver/50 self-center">+91 96148 66663</span>
              </li>
              <li className="flex gap-3">
                <div className="icon-glass w-8 h-8 flex items-center justify-center shrink-0">
                  <Mail className="w-3.5 h-3.5 text-gold" />
                </div>
                <span className="text-sm text-silver/50 self-center">info@hometech.in</span>
              </li>
              <li className="flex gap-3">
                <div className="icon-glass w-8 h-8 flex items-center justify-center shrink-0">
                  <MapPin className="w-3.5 h-3.5 text-gold" />
                </div>
                <span className="text-sm text-silver/50 self-center">
                  Kolkata, West Bengal, India
                </span>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-black/[0.06] flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-sm text-silver/30">
            &copy; 2026 HomeTech Chemical. All rights reserved.
          </p>
          <div className="flex items-center gap-6 text-sm text-silver/30">
            <a href="#" className="hover:text-gold transition-colors duration-300">
              Privacy Policy
            </a>
            <a href="#" className="hover:text-gold transition-colors duration-300">
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
