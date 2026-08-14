"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  text: string;
}

function buildComponents(): Components {
  return {
    p: ({ children }) => (
      <p className="whitespace-pre-wrap wrap-break-word text-(--ink) text-sm/relaxed my-2 first:mt-0 last:mb-0">
        {children}
      </p>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-(--ink-strong)">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="text-(--mute) line-through">{children}</del>,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-(--primary-deep) underline underline-offset-2 hover:text-(--primary)"
      >
        {children}
      </a>
    ),

    h1: ({ children }) => (
      <h1 className="font-sans text-xl font-semibold text-(--ink-strong) mt-4 mb-2 first:mt-0">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-sans text-lg font-semibold text-(--ink-strong) mt-4 mb-2 first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-sans text-base font-semibold text-(--ink-strong) mt-3 mb-1.5 first:mt-0">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="font-sans text-sm font-semibold text-(--ink-strong) mt-3 mb-1.5 first:mt-0">
        {children}
      </h4>
    ),

    ul: ({ children }) => (
      <ul className="list-disc pl-5 my-2 space-y-1 text-sm text-(--ink) marker:text-(--mute)">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 my-2 space-y-1 text-sm text-(--ink) marker:text-(--mute)">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,

    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-(--hairline) pl-3 my-2 text-(--body) italic">
        {children}
      </blockquote>
    ),

    hr: () => <hr className="border-(--hairline) my-3" />,

    code: ({ className, children, ...props }) => {
      const isBlock = /language-/.test(className ?? "");
      if (!isBlock) {
        return (
          <code
            className="font-mono text-[0.85em] bg-(--canvas-soft) border border-(--hairline) rounded px-1 py-0.5 text-(--canvas-text-soft)"
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className={`font-mono text-[13px] ${className ?? ""}`} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="font-mono text-[13px] bg-(--canvas-soft) border border-(--hairline) rounded-lg p-4 overflow-x-auto my-2 text-(--canvas-text-soft)">
        {children}
      </pre>
    ),

    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="w-full border-collapse text-[13px]">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th className="px-2 py-1 text-left border-b border-(--hairline) font-semibold text-(--mute) text-[10px] tracking-kicker uppercase">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-2 py-1 text-left text-(--ink) border-b border-(--hairline)/60">
        {children}
      </td>
    ),
  };
}

export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  const components = useMemo(buildComponents, []);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});
