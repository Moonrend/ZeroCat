import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { cn } from "@/lib/utils";

const markdownComponents: Components = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn("mt-12 scroll-mt-24 text-4xl font-semibold tracking-[-0.03em] text-foreground", className)}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn("mt-14 border-b border-border/70 pb-3 scroll-mt-24 text-3xl font-semibold tracking-[-0.025em] text-foreground", className)}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn("mt-10 scroll-mt-24 text-2xl font-semibold tracking-[-0.02em] text-foreground", className)}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn("mt-8 scroll-mt-24 text-xl font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p className={cn("my-6 text-[17px] leading-8 text-foreground/88 md:text-[18px]", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "text-[var(--color-link)] underline decoration-1 underline-offset-4 hover:decoration-2",
        className
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn("my-8 rounded-r-2xl border-l-[3px] border-[var(--color-brand)] bg-[var(--color-brand-soft)]/55 px-5 py-4 text-foreground/76 dark:bg-[color-mix(in_oklab,var(--color-brand)_10%,transparent)]", className)}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-6 list-disc space-y-2 pl-6 text-foreground/88", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-6 list-decimal space-y-2 pl-6 text-foreground/88", className)} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("text-[16px] leading-7", className)} {...props} />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("my-12 border-border/70", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-8 overflow-x-auto rounded-lg border border-border/70 bg-card/80 shadow-sm">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn("bg-muted/70 px-4 py-3 text-left text-sm font-semibold text-foreground", className)}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td className={cn("border-t border-border/60 px-4 py-3 align-top", className)} {...props} />
  ),
  img: ({ className, ...props }) => (
    <img className={cn("my-8 rounded-lg border border-border/60 shadow-sm", className)} {...props} alt={props.alt ?? ""} />
  ),
  code: ({ className, ...props }) => {
    const inline = !String(className ?? "").includes("language-");
    return inline ? (
      <code
        className={cn("rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground", className)}
        {...props}
      />
    ) : (
      <code className={cn("font-mono text-sm", className)} {...props} />
    );
  },
  pre: ({ className, ...props }) => (
    <pre
      className={cn("my-8 overflow-x-auto rounded-lg border border-border/70 bg-[#fafafa] p-5 text-sm shadow-sm dark:bg-[#111111]", className)}
      {...props}
    />
  ),
};

export function MarkdownContent({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  if (!source) return null;
  return (
    <div className={cn("max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        skipHtml
        disallowedElements={["script", "iframe", "object", "embed"]}
        unwrapDisallowed
        rehypePlugins={[
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: "prepend",
              properties: { className: ["anchor-link"], "aria-hidden": "true" },
              content: { type: "text", value: "#" },
            },
          ],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
