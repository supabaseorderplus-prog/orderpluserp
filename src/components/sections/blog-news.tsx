"use client";

import React from "react";
import Image from "next/image";
import { ArrowRight, Calendar } from "lucide-react";

const posts = [
  {
    id: 1,
    date: "Jan 28, 2026",
    category: "Research",
    title: "HomeTech's Advanced Formula: The Future of Waterproofing",
    description:
      "Our advanced molecular chain technology creates a living barrier that adapts to structural shifts and thermal expansion.",
    image:
      "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/render/image/public/project-uploads/63145925-7249-4723-ab4f-2bd2de2c6582/home-tech-5-1769700233801.jpeg",
  },
  {
    id: 2,
    date: "Jan 15, 2026",
    category: "Industry",
    title: "Industrial Strength for Residential Spaces",
    description:
      "Why settle for standard builders' grade? Our elite range uses advanced chemical technology that secures infrastructure.",
    image:
      "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/render/image/public/project-uploads/63145925-7249-4723-ab4f-2bd2de2c6582/home-tech-1769700233720.jpeg",
  },
  {
    id: 3,
    date: "Jan 02, 2026",
    category: "Science",
    title: "The Chemistry of Lasting Foundations",
    description:
      "Learn how our R&D lab develops pH-neutralizing agents that prevent rebar corrosion and extend building life.",
    image:
      "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/render/image/public/project-uploads/63145925-7249-4723-ab4f-2bd2de2c6582/home-tech-3-1769700234574.jpeg",
  },
];

const BlogNews = () => {
  return (
    <section className="relative py-24 lg:py-32 overflow-hidden" id="blog">
      <div className="absolute inset-0 bg-obsidian-light" />
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-gold/[0.02] rounded-full blur-[120px] -translate-y-1/4 translate-x-1/4" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-4 mb-16">
          <div>
            <div className="section-badge mb-6">Insights</div>
            <h2>
              Latest from Our <span className="gold-gradient">Lab</span>
            </h2>
          </div>
          <a
            href="#"
            className="inline-flex items-center gap-2 text-sm font-semibold text-gold hover:gap-3 transition-all duration-300"
          >
            All Articles <ArrowRight className="w-4 h-4" />
          </a>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {posts.map((post) => (
            <article key={post.id} className="glass-card-hover overflow-hidden group">
              <div className="relative aspect-[16/10] overflow-hidden bg-obsidian-lighter">
                <Image
                  src={post.image}
                  alt={post.title}
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-obsidian/60 to-transparent" />
                <div className="absolute top-4 left-4 section-badge !py-1 !px-3 !text-[0.7rem]">
                  {post.category}
                </div>
              </div>

              <div className="p-6">
                <div className="flex items-center gap-2 text-xs text-silver/40 mb-3">
                  <Calendar className="w-3.5 h-3.5" />
                  {post.date}
                </div>

                <h3 className="font-display font-bold text-foreground mb-2 group-hover:text-gold transition-colors duration-300 leading-snug">
                  {post.title}
                </h3>

                <p className="text-sm text-silver/50 mb-4 line-clamp-2 leading-relaxed">
                  {post.description}
                </p>

                <a
                  href="#"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-gold hover:gap-2.5 transition-all duration-300"
                >
                  Read More <ArrowRight className="w-3.5 h-3.5" />
                </a>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
};

export default BlogNews;
