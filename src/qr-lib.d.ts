/** qrcode-generator (MIT), aliased in vite.config.ts. Only the parts we use. */
declare module "qr-lib" {
  interface QRCode {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
  const qrcode: (typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H") => QRCode;
  export default qrcode;
}
