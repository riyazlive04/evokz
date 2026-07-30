import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1600px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // The three evokz.in wordmark stops, addressable on their own so a
        // component can reach for one end of the ramp (`text-brand-to`)
        // without pulling in the whole gradient.
        brand: {
          from: 'hsl(var(--brand-from))',
          via: 'hsl(var(--brand-via))',
          to: 'hsl(var(--brand-to))',
          DEFAULT: 'hsl(var(--brand-via))',
        },
      },
      backgroundImage: {
        'gradient-brand':
          'linear-gradient(100deg, hsl(var(--brand-from)), hsl(var(--brand-via)), hsl(var(--brand-to)))',
        'gradient-brand-diagonal':
          'linear-gradient(135deg, hsl(var(--brand-from)), hsl(var(--brand-via)), hsl(var(--brand-to)))',
        // Tinted wash for card fills and hover states — the site uses the same
        // idea on its light icon tiles, just inverted for the dark shell.
        'gradient-brand-soft':
          'linear-gradient(135deg, hsl(var(--brand-from) / 0.16), hsl(var(--brand-to) / 0.06))',
        // Elevated surface. Runs card -> muted rather than card -> background
        // so it stays visible on the light theme, where card and background
        // are both pure white and a card->background ramp would be flat.
        'gradient-surface':
          'linear-gradient(160deg, hsl(var(--card)), hsl(var(--muted)))',
        'gradient-brand-radial':
          'radial-gradient(ellipse at top, hsl(var(--brand-from) / 0.22), transparent 60%)',
      },
      boxShadow: {
        // Replaces the hardcoded rgba(6,182,212,…) cyan glows; both stops now
        // follow the tokens, so the glow re-tints with the palette.
        'brand-glow': '0 0 18px rgb(var(--brand-from-rgb) / 0.25)',
        'brand-glow-sm': '0 0 15px rgb(var(--brand-to-rgb) / 0.15)',
        'brand-glow-lg': '0 0 28px rgb(var(--brand-to-rgb) / 0.28)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    // Micro-3D primitives. Tailwind v3 ships no perspective / rotateX / rotateY
    // utilities, so the blueprint's `perspective-1000 rotate-x-6 rotate-y-6`
    // classes are registered here. Both axes write into shared custom
    // properties and re-declare the same `transform`, so `rotate-x-*` and
    // `rotate-y-*` compose instead of overwriting one another, and the
    // resolved transform stays interpolatable for `transition-all`.
    plugin(({ addUtilities, matchUtilities, theme }) => {
      addUtilities({
        '.perspective-500': { perspective: '500px' },
        '.perspective-1000': { perspective: '1000px' },
        '.perspective-1500': { perspective: '1500px' },
        '.perspective-none': { perspective: 'none' },
        '.preserve-3d': { transformStyle: 'preserve-3d' },
        '.backface-hidden': { backfaceVisibility: 'hidden' },
        '.transform-gpu-3d': { transform: 'translate3d(0, 0, 0)' },
      });

      const axisTransform =
        'rotateX(var(--ace-rotate-x, 0deg)) rotateY(var(--ace-rotate-y, 0deg)) rotateZ(var(--ace-rotate-z, 0deg))';

      matchUtilities(
        {
          'rotate-x': (value) => ({
            '--ace-rotate-x': value,
            transform: axisTransform,
          }),
          'rotate-y': (value) => ({
            '--ace-rotate-y': value,
            transform: axisTransform,
          }),
          'rotate-z': (value) => ({
            '--ace-rotate-z': value,
            transform: axisTransform,
          }),
        },
        { values: theme('rotate'), supportsNegativeValues: true },
      );
    }),
  ],
};

export default config;
