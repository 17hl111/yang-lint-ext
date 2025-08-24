import sys, pathlib, shutil

if len(sys.argv) != 2:
    print("Usage: converter.py <source.py> test for sample")
    sys.exit(1)

src = pathlib.Path(sys.argv[1]).resolve()
dst = src.with_suffix('.txt')

# 这里的“转换”只是复制。以后换成真正逻辑即可。
shutil.copy(src, dst)

print(f"[converter] {src.name} → {dst.name}")
