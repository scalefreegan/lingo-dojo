// opencc-js publishes its dictionary tables (dist/esm-lib/dict/*.js, each
// a default-exported string "萬 万|與 与|…") without type declarations;
// t2s.ts imports four of them by name.
declare module "opencc-js/dict/*" {
  const dict: string;
  export default dict;
}
