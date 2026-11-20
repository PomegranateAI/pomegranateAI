// =============================================================================
// "Run this in Claude or ChatGPT" — MCP usage callout for Collaboration views.
//
// Every Collaboration surface (Ask, Alignment, Updates, Dependency, Standards)
// has a matching way to do the same job from an assistant that has Pomegranate's
// MCP server connected. This is a compact, consistent invite: a one-line nudge
// (styled like the "Set up rules" nudge in Curate) with a link that expands into
// recipe cards — each mapping the use case to the exact MCP tool(s) to call, with
// an example prompt the user can copy and paste into Claude or ChatGPT.
// =============================================================================
import { useState } from 'react';
import { Sparkles, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface McpRecipe {
  /** The use case, phrased as an outcome. */
  title: string;
  /** One line on what running it from an assistant gets you. */
  detail: string;
  /** The Pomegranate MCP tools this recipe calls, in order. */
  tools: string[];
  /** A ready-to-paste prompt for Claude / ChatGPT. */
  prompt: string;
}

function PromptBlock({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text is still selectable */
    }
  };
  return (
    <div className="group relative mt-2 rounded-md border bg-muted/40 px-2.5 py-2 pr-8 font-mono text-[12px] leading-relaxed text-foreground/90">
      <span className="select-all">{prompt}</span>
      <button
        type="button"
        onClick={copy}
        title="Copy prompt"
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
      >
        {copied ? <Check className="size-3.5 text-flag-green" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export function RunInClaude({
  useCase,
  recipes,
  className,
}: {
  /** Short name of what these views do, e.g. "ask the canon" or "check dependencies". */
  useCase: string;
  recipes: McpRecipe[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={cn('overflow-hidden shadow-soft', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 p-3 text-left text-sm text-muted-foreground"
      >
        <Sparkles className="size-4 shrink-0 text-pome-red" />
        <span>
          Prefer to work where you already are? Run{' '}
          <span className="font-medium text-foreground">{useCase}</span> from Claude or ChatGPT with
          Pomegranate's MCP tools.{' '}
          <span className="font-medium text-foreground underline decoration-pome-red/40 underline-offset-2">
            {open ? 'Hide' : 'See how'}
          </span>
        </span>
        {open ? (
          <ChevronDown className="ml-auto size-4 shrink-0" />
        ) : (
          <ChevronRight className="ml-auto size-4 shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t p-3">
          <p className="mb-3 text-xs text-muted-foreground">
            Connect Pomegranate as an MCP server in Claude or ChatGPT, then ask in plain language —
            the assistant calls these tools against your directory (and any teammate directory you name).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {recipes.map((r) => (
              <div key={r.title} className="rounded-lg border p-3">
                <div className="font-medium">{r.title}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">{r.detail}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {r.tools.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-pome-red/25 bg-pome-red/5 px-1.5 py-0.5 font-mono text-[11px] text-pome-red"
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <PromptBlock prompt={r.prompt} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
