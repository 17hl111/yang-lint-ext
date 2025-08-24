FROM python:3.12-slim

# 容器里的工作目录
WORKDIR /app

# 把转换脚本复制进去
COPY converter.py /app/

# 容器启动就执行这个脚本
ENTRYPOINT ["python", "/app/converter.py"]

