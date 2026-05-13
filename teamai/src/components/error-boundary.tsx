'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  /** Label shown in production mode (default: "Something went wrong") */
  prodMessage?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[error-boundary]', error.message, '\nComponent stack:', info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isDev = process.env.NODE_ENV !== 'production';

      return (
        <div className="flex flex-col items-center justify-center min-h-[200px] p-8 rounded-lg border border-red-500/20 bg-red-500/5">
          <div className="text-red-400 text-4xl mb-4">⚠</div>
          <h2 className="text-lg font-semibold text-red-300 mb-2">
            {isDev ? 'Render Error' : (this.props.prodMessage ?? 'Something went wrong')}
          </h2>
          {isDev && this.state.error && (
            <pre className="text-xs text-red-400/70 bg-black/20 rounded p-3 mb-4 max-w-full overflow-auto max-h-32">
              {this.state.error.message}
              {this.state.error.stack && (
                <>
                  {'\n'}
                  {this.state.error.stack}
                </>
              )}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="px-4 py-2 text-sm font-medium rounded-md bg-red-500/10 text-red-300 hover:bg-red-500/20 border border-red-500/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
