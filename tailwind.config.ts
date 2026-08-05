import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';
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
        // Navy -> Sand wordmark stops; reach for one end (`text-brand-to`) without
        // pulling in the whole gradient.
        brand: {
          from: 'hsl(var(--brand-from))',
          via: 'hsl(var(--brand-via))',
          to: 'hsl(var(--brand-to))',
          DEFAULT: 'hsl(var(--brand-via))',
        },
        // Status. `DEFAULT` is the solid fill, `foreground` is ink ON that
        // fill, `ink` is ink on the page ground. Reach for `-ink` whenever the
        // colour is text or an icon sitting on a card or the body.
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
          ink: 'hsl(var(--success-ink))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          ink: 'hsl(var(--warning-ink))',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger))',
          foreground: 'hsl(var(--danger-foreground))',
          ink: 'hsl(var(--danger-ink))',
        },
        scrim: 'hsl(var(--scrim))',

        // Literal ramps, deliberately NOT token-driven. These exist only for
        // surfaces that must stay fixed regardless of theme — overlays on
        // generated creatives, chips on client swatches. Reaching for these in
        // ordinary UI is a bug: use the semantic tokens above instead.
        navy: {
          50: '#f2f7fc',
          100: '#e3edf7',
          200: '#c8d8ea',
          300: '#9dbad6',
          400: '#6b8fb8',
          500: '#47698f',
          600: '#2f5077',
          700: '#213a56',
          800: '#16294b',
          900: '#0f1e3f',
          950: '#0a1530',
        },
        sand: {
          50: '#f7f0e6',
          100: '#ecdcc7',
          200: '#ddc4a3',
          300: '#cdaa80',
          400: '#b8926a',
          500: '#997953',
          600: '#7d6244',
          700: '#5f4a34',
        },
      },
      fontFamily: {
        // `--font-inter` is declared in src/app/layout.tsx and applied via
        // `font-sans` on <body>, but without this extension `font-sans`
        // resolves to Tailwind's stock stack and Inter never actually loads.
        sans: ['var(--font-inter)', ...defaultTheme.fontFamily.sans],
      },
      backgroundImage: {
        'gradient-brand':
          'linear-gradient(100deg, hsl(var(--brand-from)), hsl(var(--brand-via)), hsl(var(--brand-to)))',
        'gradient-brand-diagonal':
          'linear-gradient(135deg, hsl(var(--brand-from)), hsl(var(--brand-via)), hsl(var(--brand-to)))',
        // Tinted wash for card fills and hover states on the dark canvas.
        'gradient-brand-soft':
          'linear-gradient(135deg, hsl(var(--brand-from) / 0.16), hsl(var(--brand-to) / 0.06))',
        // Elevated surface: card -> muted so the ramp reads on light backgrounds.
        'gradient-surface':
          'linear-gradient(160deg, hsl(var(--card)), hsl(var(--muted)))',
        'gradient-brand-radial':
          'radial-gradient(ellipse at top, hsl(var(--brand-from) / 0.22), transparent 60%)',
      },
      boxShadow: {
        'brand-glow': '0 0 18px rgb(var(--primary-rgb) / 0.35)',
        'brand-glow-sm': '0 0 15px rgb(var(--primary-rgb) / 0.2)',
        'brand-glow-lg': '0 0 28px rgb(var(--primary-rgb) / 0.4)',
        // Named replacements for the raw rgba(2,6,23,…) values in
        // BrandCanvasView, retargeted from slate-950 to navy-950.
        'canvas-float': '0 8px 40px hsl(var(--scrim) / 0.9)',
        'canvas-card': '0 18px 45px -20px hsl(var(--scrim) / 0.95)',
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
