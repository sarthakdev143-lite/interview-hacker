/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#05070c',
        panel: '#0b1020',
        glow: '#61f3c1',
        ember: '#ffb86c',
        storm: '#7aa2ff',
      },
      fontFamily: {
        sans: ['Aptos', 'Segoe UI Variable', 'Segoe UI', 'sans-serif'],
        mono: ['IBM Plex Mono', 'Consolas', 'monospace'],
      },
      boxShadow: {
        halo: '0 24px 80px rgba(1, 7, 19, 0.45)',
      },
      backgroundImage: {
        aurora:
          'radial-gradient(circle at top left, rgba(122,162,255,0.28), transparent 40%), radial-gradient(circle at 85% 10%, rgba(97,243,193,0.18), transparent 28%), linear-gradient(140deg, rgba(5,7,12,0.98), rgba(11,16,32,0.94))',
      },
      keyframes: {
        pulseSoft: {
          '0%, 100%': { opacity: '0.45', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.12)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        blink: {
          '0%, 45%': { opacity: '1' },
          '46%, 100%': { opacity: '0' },
        },
        rise: {
          '0%': { opacity: '0', transform: 'translateY(18px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-soft': 'pulseSoft 1.8s ease-in-out infinite',
        shimmer: 'shimmer 3.5s linear infinite',
        blink: 'blink 1.05s step-end infinite',
        rise: 'rise 0.42s ease-out',
      },
    },
  },
  plugins: [],
};
