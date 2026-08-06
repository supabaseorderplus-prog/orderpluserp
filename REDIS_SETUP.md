# Redis Setup Guide

## Current Status
✅ **Application now works WITHOUT Redis!**

The application has been updated to gracefully handle Redis connection failures. You can now run the application without Redis, though some features will have reduced performance.

## What Works Without Redis?
- ✅ Login/Logout (basic authentication)
- ✅ User management
- ✅ All CRUD operations
- ✅ Permission checks (fetched from database)

## What's Affected Without Redis?
- ⚠️ Permission caching (slower, but functional)
- ⚠️ Refresh token validation (less secure, but works)
- ❌ Password reset (requires Redis)

## Option 1: Run Without Redis (Current Setup)
Just start your backend server:
```bash
cd backend
npm run dev
```

The application will show warnings about Redis but will continue to work.

## Option 2: Install and Run Redis (Recommended for Production)

### macOS (using Homebrew)
```bash
# Install Redis
brew install redis

# Start Redis
brew services start redis

# Or run Redis in foreground
redis-server
```

### Linux (Ubuntu/Debian)
```bash
# Install Redis
sudo apt-get update
sudo apt-get install redis-server

# Start Redis
sudo systemctl start redis-server

# Enable Redis to start on boot
sudo systemctl enable redis-server
```

### Windows
1. Download Redis from: https://github.com/microsoftarchive/redis/releases
2. Extract and run `redis-server.exe`

Or use Docker:
```bash
docker run -d -p 6379:6379 redis:alpine
```

### Using Docker (All Platforms)
```bash
# Run Redis in a container
docker run -d --name redis -p 6379:6379 redis:alpine

# Stop Redis
docker stop redis

# Start Redis again
docker start redis
```

## Verify Redis is Running
```bash
# Test Redis connection
redis-cli ping
# Should return: PONG
```

## Super Admin Login Credentials
- **Email:** admin@hometech.com
- **Password:** Admin@123
- **Role:** SUPER_ADMIN

## Troubleshooting

### If you see Redis errors but want to continue without it:
The application will automatically continue without Redis. Just ignore the warnings.

### If you want to use Redis:
1. Install Redis using one of the methods above
2. Make sure it's running on port 6379
3. Restart your backend server

### Check if Redis is running:
```bash
# macOS/Linux
lsof -i :6379

# Or try to connect
redis-cli ping
```

## Environment Variables
Your `.env` file should have:
```env
REDIS_URL=redis://localhost:6379
```

This is already configured in your `.env` file.
