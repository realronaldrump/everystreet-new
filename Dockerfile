# Use official Python 3.12 image
FROM python:3.12

# Ensure Python outputs are not buffered
ENV PYTHONUNBUFFERED=1

# Update and install necessary dependencies
RUN apt-get update && apt-get install -y \
    libexpat1 \
    libexpat1-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory inside the container
WORKDIR /app

# Copy and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . ./

# Run the application using Python directly
CMD ["python", "app.py"]
