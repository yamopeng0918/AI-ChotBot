declare module "*.json" {
  const value: unknown;
  export default value;
}

interface ImportMeta {
  readonly url: string;
}
