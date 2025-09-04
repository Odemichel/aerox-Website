import typographyPlugin from '@tailwindcss/typography';
import defaultTheme from 'tailwindcss/defaultTheme';
import plugin from 'tailwindcss/plugin';

export default {
  content: ['./src/**/*.{astro,html,js,jsx,json,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    
    extend: {
      colors: {
        gradientprimary: 'var(--gradient-primary)',
        primary: 'var(--aw-color-primary)',
        secondary: 'var(--aw-color-secondary)',
        accent: 'var(--aw-color-accent)',
        default: 'var(--aw-color-text-default)',
        muted: 'var(--aw-color-text-muted)',
      },
      fontFamily: {
        sans: ['var(--aw-font-sans, ui-sans-serif)', ...defaultTheme.fontFamily.sans],
        serif: ['var(--aw-font-serif, ui-serif)', ...defaultTheme.fontFamily.serif],
        heading: ['var(--aw-font-heading, ui-sans-serif)', ...defaultTheme.fontFamily.sans],
      },

      animation: {
        fade: 'fadeInUp 1s both',
        blur: 'blurInUp 3s both',
        fadedelay3s: 'fadeInUp 0.2s ease-out 6s forwards', // <- délai 3s

      },

      keyframes: {
        fadeInUp: {
          '0%': { opacity: 0,  transform: 'translateY(80px)', },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        blurInUp: {
          '0%': { opacity: 0,  transform: 'translateY(0px)', filter: 'blur(8px)'},
          '100%': { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
        },
      },
      
      backgroundImage: {
    'primary-gradient': 'linear-gradient(135deg, var(--aw-color-primary), var(--aw-color-accent))',
  },
    },
  },
  plugins: [
    typographyPlugin,
    plugin(({ addVariant }) => {
      addVariant('intersect', '&:not([no-intersect])');
    }),
  ],
  darkMode: 'class',
};
