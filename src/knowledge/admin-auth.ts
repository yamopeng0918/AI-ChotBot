const encoder = new TextEncoder();

export async function verifyAdminBearer(
  header: string | undefined,
  expectedToken: string,
): Promise<boolean> {
  if (!header?.startsWith("Bearer ")) return false;

  const token = header.slice("Bearer ".length);
  if (!token) return false;

  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  const actual = new Uint8Array(actualDigest);
  const expected = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= actual[index]! ^ expected[index]!;
  }
  return difference === 0;
}
