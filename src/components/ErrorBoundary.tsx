import React from "react";
import { ArrowClockwise, Warning } from "@phosphor-icons/react";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Catches uncaught render-time errors anywhere in the tree and shows a
 * recoverable fallback instead of leaving the WebView with a blank body.
 * Previously a JS exception during a model/agent swap could unmount React's
 * root and you'd see a white screen — this boundary prevents that.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[AKA] Render-time error caught by ErrorBoundary:", error, info);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[radial-gradient(ellipse_80%_60%_at_50%_100%,#26003f,#13001f)] p-8 text-white">
        <div className="w-[480px] max-w-[90vw] rounded-2xl border border-rose-400/30 bg-rose-500/10 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
          <div className="mb-3 flex items-center gap-2.5">
            <Warning size={22} weight="fill" className="text-rose-300" />
            <h2 className="text-base font-medium">Something went wrong</h2>
          </div>
          <p className="mb-2 text-sm text-white/80">
            A render-time error was caught before it could blank the workspace.
          </p>
          <pre className="mb-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] text-rose-100/85">
            {this.state.error.message}
          </pre>
          <div className="flex justify-end gap-2">
            <button
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10"
            >
              <ArrowClockwise size={11} weight="bold" />
              Reload
            </button>
            <button
              onClick={this.handleReset}
              className="rounded-md bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-400"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
