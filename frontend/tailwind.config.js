/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Bumped up one notch across the board - text-xs buttons and text-sm body copy were
      // reading too small to be comfortable; this keeps every existing text-* class but larger.
      fontSize: {
        xs: '0.8125rem',
        sm: '0.9375rem',
        base: '1.0625rem',
        lg: '1.1875rem',
        xl: '1.375rem',
        '2xl': '1.625rem',
        '3xl': '2rem',
      },
      // Same palette as the MAGI web frontend (magi_ap_test), so the desktop app and the
      // web app read as one product.
      colors: {
        "magi-white": "#FFFFFF",
        "magi-surface": "#F5F5F5",
        "magi-border": "#E5E5E5",
        "magi-primary": "#0A0A0A",
        "magi-secondary": "#6B6B6B",
        "magi-accent": "#1A1A1A",
        "magi-hover": "#333333",
        "magi-destructive": "#DC2626",
        "magi-success": "#16A34A",
      },
      fontFamily: {
        outfit: ["Outfit", "Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
