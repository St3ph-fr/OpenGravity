import sys
import base64

# Force stdout to use UTF-8 to prevent Windows terminal charmap encoding errors
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def decode_base64url(data):
    # Add necessary padding and replace URL-safe characters
    rem = len(data) % 4
    if rem > 0:
        data += '=' * (4 - rem)
    # base64.urlsafe_b64decode works with '-' and '_' replacements
    return base64.urlsafe_b64decode(data.encode('ascii'))

def main():
    if len(sys.argv) > 1:
        # Read from argument
        data = sys.argv[1]
    else:
        # Read from stdin
        data = sys.stdin.read().strip()
    
    if not data:
        print("Error: No data provided", file=sys.stderr)
        sys.exit(1)
        
    try:
        decoded_bytes = decode_base64url(data)
        # Attempt to decode as utf-8 string, fallback to writing raw bytes if binary (e.g. attachments)
        try:
            print(decoded_bytes.decode('utf-8'))
        except UnicodeDecodeError:
            # If it's a binary file (e.g. PDF/Image attachment), write directly to stdout buffer
            sys.stdout.buffer.write(decoded_bytes)
    except Exception as e:
        print(f"Decoding failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
