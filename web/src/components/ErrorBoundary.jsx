import { Component } from 'react';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '1rem',
          fontFamily: "'Instrument Sans', system-ui, sans-serif",
          color: 'var(--text-color-text-main, #282726)',
        }}>
          <h2 style={{ margin: 0 }}>Something went wrong</h2>
          <p style={{ color: 'var(--text-color-text-subtle, #878580)', margin: 0 }}>
            An unexpected error occurred.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px',
              borderRadius: 'var(--radius-sm, 8px)',
              border: '1px solid var(--borders-color-border-2, #ccc)',
              background: 'var(--glass-bg-solid, #f5f5f5)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: '14px',
              color: 'inherit',
            }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
