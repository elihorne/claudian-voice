/** Opens the microphone with a readable error when the OS or user refuses. */
export async function openMicrophone(constraints: MediaTrackConstraints): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('Microphone access was denied. Allow Obsidian to use the microphone in System Settings → Privacy & Security → Microphone, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new Error('No microphone was found. Connect one or pick an input device in System Settings → Sound.');
    }
    if (name === 'NotReadableError') {
      throw new Error('The microphone is in use by another application.');
    }
    throw error;
  }
}
