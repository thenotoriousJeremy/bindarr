import sys

with open('frontend/src/index.css', 'rb') as f:
    data = f.read()

# find where the null bytes start happening
# powershell appends utf-16le. UTF-16le has null bytes for ascii chars.
# we'll look for null bytes.
null_idx = data.find(b'\x00')
if null_idx == -1:
    print("No null bytes found")
else:
    # go back slightly to the start of the appended text.
    # actually, we can just remove all null bytes!
    # Wait, if there are non-ascii chars, removing null bytes will break them.
    # Let's decode the file.
    
    # We can just decode the file ignoring null bytes if it's just CSS.
    clean_data = data.replace(b'\x00', b'')
    with open('frontend/src/index.css', 'wb') as f:
        f.write(clean_data)
    print("Cleaned null bytes from index.css")
