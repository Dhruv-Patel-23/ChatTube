# ✅ MATCH YOUR LOCAL VERSION (3.12)
FROM python:3.12-slim

# 1. Install system dependencies
# FFmpeg is required for audio splitting
# git is often needed for installing dependencies from GitHub
RUN apt-get update && apt-get install -y ffmpeg git

# 2. Set up working directory
WORKDIR /app

# 3. Copy requirements and install Python libraries
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copy the rest of the backend code
COPY . .

# 5. Open the port
EXPOSE 8000

# 6. Start the server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]