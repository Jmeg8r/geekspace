import { Component, type ErrorInfo, type ReactNode } from "react";

// WHAT: catches an error thrown while rendering its children and shows `fallback` instead.
// WHY: without one, React unmounts the whole tree on any render error, so one failing
// query (2026-10-17: a stale pages:get rejecting a persisted page id) blanked the window.
// Remount with a new `key` to reset from outside; `reset` retries from inside.
type BoundaryProps = {
  fallback: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
};
type BoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  // WHY Error: everything this app's render paths throw is an Error, Convex client
  // errors included.
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}
