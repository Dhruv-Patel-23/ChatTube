/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.{tsx,ts,jsx,js}",      // <--- ADD THIS LINE (scans root files like sidepanel.tsx)
    "./src/**/*.{tsx,ts,jsx,js}" // (Keep this just in case you create a src folder later)
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('@tailwindcss/typography')
  ],
}