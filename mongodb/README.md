# MongoDB Database Service

MongoDB database service for the Configuration Management System, providing persistent storage for experiment configurations and metadata.

## Overview

This MongoDB instance serves as the primary data store for the Configuration Management System. It works in conjunction with the Configuration API service to provide persistent storage for experiment configurations, metadata, and operational data.

## Database Configuration

### Database Structure
- **Database Name**: `quix`
- **Primary Collection**: `configuration-api`
- **Authentication**: Root user authentication enabled

### Connection Details
- **Service Name**: `mongodb`
- **Port**: `27017`
- **Host**: Available internally as `mongodb` within the Quix platform

## Environment Variables

- **MONGO_INITDB_ROOT_USERNAME**: Root username (default: `admin`)
- **MONGO_INITDB_ROOT_PASSWORD**: Root password (stored as secret: `mongo_password`)

## Integration with Configuration API

The Configuration API service connects to this MongoDB instance using:

```yaml
MONGO_DATABASE: "quix"
MONGO_COLLECTION: "configuration-api"
MONGO_URL: "mongodb://admin:<password>@mongodb:27017/quix?authSource=admin"
```

## Data Schema

The `configuration-api` collection stores experiment configurations with the following structure:

```json
{
  "_id": "ObjectId",
  "id": "unique-config-id",
  "metadata": {
    "type": "experiment-cfg",
    "category": "Test rig",
    "target_key": "machine1",
    "valid_from": "2025-06-27T13:01:09.830Z",
    "version": 1,
    "created_at": "2025-06-27T13:01:09.830Z",
    "updated_at": "2025-06-27T13:01:09.830Z"
  },
  "content": {
    "experiment_name": "Test Experiment",
    "mapping": {
      "sensor1": "temperature",
      "sensor2": "humidity"
    },
    "machine_id": "machine1",
    "test_engineer": "Engineer Name",
    "location": "Prague",
    "MATERIAL": "abs",
    "price_per_kg": 22.0
  }
}
```

## Deployment Configuration

### Resource Allocation
- **CPU**: 200m
- **Memory**: 800MB
- **Storage**: 1GB persistent state (required)
- **Replicas**: 1

### State Management
- **State Enabled**: Yes (1GB)
- **Persistence**: Required for data durability
- **Backup**: Handled through Quix platform state management

## Connection Examples

### From Configuration API
```python
import pymongo
from pymongo import MongoClient

client = MongoClient("mongodb://admin:password@mongodb:27017/?authSource=admin")
db = client["quix"]
collection = db["configuration-api"]
```

### From External Services
```bash
# Connection string format
mongodb://admin:<password>@mongodb:27017/quix?authSource=admin
```

## Administration

### Initial Setup
1. MongoDB starts with root user credentials
2. Database `quix` is created automatically
3. Collection `configuration-api` is created on first use
4. Indexes are created by the Configuration API service

### Backup & Recovery
- Data is persisted through Quix state management
- Regular snapshots are handled by the platform
- State can be restored from platform backups

## Security

### Authentication
- Root user authentication required
- Password stored securely in Quix secrets
- Network isolation within Quix platform

### Access Control
- Only accessible from within the Quix platform network
- No external public access
- Service-to-service authentication required

## Monitoring

### Health Checks
- MongoDB health monitored by Quix platform
- Connection status tracked by Configuration API
- Resource usage metrics available in Quix dashboard

### Logging
- MongoDB logs available through Quix platform
- Query performance logging enabled
- Connection and authentication events logged

## Performance

### Indexing Strategy
Indexes are typically created by the Configuration API service for:
- `metadata.target_key`: Fast lookups by machine ID
- `metadata.type`: Configuration type filtering
- `metadata.created_at`: Time-based queries
- `id`: Unique identifier lookups

### Scaling Considerations
- Single replica deployment for development/staging
- Can be scaled to replica sets for production
- Resource allocation can be adjusted based on load

## Troubleshooting

### Common Issues
1. **Connection Failures**: Check network configuration and credentials
2. **Storage Full**: Monitor state usage and increase allocation if needed
3. **Performance Issues**: Review indexes and query patterns
4. **Authentication Errors**: Verify secret configuration

### Diagnostics
```bash
# Check MongoDB status
kubectl exec -it <mongodb-pod> -- mongo --eval "db.adminCommand('ping')"

# View collection stats
kubectl exec -it <mongodb-pod> -- mongo quix --eval "db.configuration-api.stats()"
```

## Docker Image Details

- **Base Image**: Official MongoDB Docker image
- **Version**: Latest stable version
- **Initialization**: Custom init scripts in `/docker-entrypoint-initdb.d/`
- **Configuration**: Default MongoDB configuration with authentication