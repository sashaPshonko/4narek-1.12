export function clonePacket(data) {
    if (data == null) return data;
    try {
        return structuredClone(data);
    } catch {
        return data;
    }
}
