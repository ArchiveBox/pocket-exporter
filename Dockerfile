# Base image
FROM ubuntu:24.04

# Install Node.js and npm
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app
# Create a non-root user
RUN useradd -m -u 1001 nextjs

# Change ownership of the app directory
RUN chown nextjs:nextjs /app

# Switch to non-root user
USER nextjs

# Copy package files with correct ownership
COPY --chown=nextjs:nextjs package.json package-lock.json* ./

# Install dependencies
RUN npm ci --legacy-peer-deps

# Copy application files with correct ownership
COPY --chown=nextjs:nextjs . .

# Build the Next.js application with dummy env vars to prevent initialization errors
ENV STRIPE_SECRET_KEY=dummy_key_for_build
ENV STRIPE_WEBHOOK_SECRET=dummy_secret_for_build
RUN npm run build

# Expose port
EXPOSE 3000

# Set environment variables for Next.js to listen on all interfaces
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# Start the application
CMD ["npm", "start"]
