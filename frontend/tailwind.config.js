/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F6F5F2',
        ink: '#171A1C',
        line: '#DBD8D1',
        slate: '#3E4C59',
        muted: '#6B7280',
        healthy: '#146C63',
        'healthy-soft': '#E4EFED',
        retrying: '#A8631A',
        'retrying-soft': '#F3E9DC',
        failed: '#A23B2A',
        'failed-soft': '#F4E3DF',
        pending: '#6B7280',
        'pending-soft': '#E9E9E7',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'pulse-dot': 'pulseDot 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
