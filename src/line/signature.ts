const encoder = new TextEncoder();

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0) return null;

  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function verifyLineSignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const supplied = decodeBase64(signature);
  if (supplied === null) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );

  if (supplied.length !== expected.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ supplied[index]!;
  }
  return difference === 0;
}
