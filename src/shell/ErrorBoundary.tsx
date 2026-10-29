import { Component, type ReactNode } from "react";

/** Keeps one broken card from taking down the whole dashboard. */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}]`, error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card-crash">
        <strong>{this.props.name} hit an error</strong>
        <code>{this.state.error.message}</code>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
