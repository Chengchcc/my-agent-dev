# API Documentation

## Overview

This API documentation provides comprehensive information for developers to integrate and use our service. The API follows RESTful principles, uses JSON for data exchange, and provides a consistent interface for all endpoints.

## Base URL

All API requests are made to:
```
https://api.example.com/v1
```

## Authentication

### API Key Authentication

The API uses API keys for authentication. You can generate an API key from the developer dashboard.

#### How to authenticate
1. Generate an API key from your account settings
2. Include the API key in the request headers:

```http
Authorization: Bearer YOUR_API_KEY
```

## Response Formats

All API responses are in JSON format with the following structure:

```json
{
  "success": true,
  "data": {},
  "message": "Success message",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### Error Response Format

```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Error message detailing what went wrong"
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## Endpoints

### 1. Create Resource

**Endpoint:** `POST /resources`

**Description:** Creates a new resource in the system.

#### Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name of the resource (min 2 characters, max 100 characters) |
| `description` | string | No | Detailed description of the resource |
| `tags` | array | No | Array of tags for categorization |
| `metadata` | object | No | Additional metadata as key-value pairs |

#### Example Request

```http
POST /resources HTTP/1.1
Host: api.example.com
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{
  "name": "Sample Resource",
  "description": "This is a sample resource for testing purposes",
  "tags": ["sample", "test"],
  "metadata": {
    "category": "testing",
    "version": "1.0"
  }
}
```

#### Success Response (201 Created)

```json
{
  "success": true,
  "data": {
    "id": "123456",
    "name": "Sample Resource",
    "description": "This is a sample resource for testing purposes",
    "tags": ["sample", "test"],
    "metadata": {
      "category": "testing",
      "version": "1.0"
    },
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  },
  "message": "Resource created successfully",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

#### Error Responses

| Status Code | Error Code | Description |
|------------|------------|-------------|
| 400 | INVALID_REQUEST | Missing required parameter 'name' |
| 401 | UNAUTHORIZED | Invalid or missing API key |
| 409 | CONFLICT | Resource with this name already exists |
| 500 | INTERNAL_ERROR | Server encountered an unexpected error |

### 2. List Resources

**Endpoint:** `GET /resources`

**Description:** Returns a list of available resources.

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Number of resources to return per page (default: 10, max: 100) |
| `offset` | integer | No | Offset for pagination (default: 0) |
| `search` | string | No | Search query to filter resources by name or description |
| `tags` | array | No | Filter resources by tags |

#### Example Request

```http
GET /resources?limit=20&offset=0&search=sample&tags[]=test&tags[]=sample HTTP/1.1
Host: api.example.com
Authorization: Bearer YOUR_API_KEY
```

#### Success Response (200 OK)

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "123456",
        "name": "Sample Resource",
        "description": "This is a sample resource for testing purposes",
        "tags": ["sample", "test"],
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z"
      },
      {
        "id": "789012",
        "name": "Another Sample",
        "description": "Another example resource",
        "tags": ["sample"],
        "created_at": "2024-01-02T00:00:00Z",
        "updated_at": "2024-01-02T00:00:00Z"
      }
    ],
    "total": 2,
    "limit": 20,
    "offset": 0
  },
  "message": "Resources retrieved successfully",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### 3. Get Resource Details

**Endpoint:** `GET /resources/:id`

**Description:** Returns detailed information about a specific resource.

#### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Unique identifier of the resource |

#### Example Request

```http
GET /resources/123456 HTTP/1.1
Host: api.example.com
Authorization: Bearer YOUR_API_KEY
```

#### Success Response (200 OK)

```json
{
  "success": true,
  "data": {
    "id": "123456",
    "name": "Sample Resource",
    "description": "This is a sample resource for testing purposes",
    "tags": ["sample", "test"],
    "metadata": {
      "category": "testing",
      "version": "1.0"
    },
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  },
  "message": "Resource retrieved successfully",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

#### Error Responses

| Status Code | Error Code | Description |
|------------|------------|-------------|
| 404 | NOT_FOUND | Resource not found |

### 4. Update Resource

**Endpoint:** `PUT /resources/:id`

**Description:** Updates an existing resource.

#### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Unique identifier of the resource |

#### Request Parameters

All fields from the Create Resource endpoint are available for updating.

#### Example Request

```http
PUT /resources/123456 HTTP/1.1
Host: api.example.com
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{
  "name": "Updated Sample Resource",
  "description": "This is an updated sample resource",
  "tags": ["sample", "test", "updated"],
  "metadata": {
    "category": "testing",
    "version": "1.1"
  }
}
```

#### Success Response (200 OK)

```json
{
  "success": true,
  "data": {
    "id": "123456",
    "name": "Updated Sample Resource",
    "description": "This is an updated sample resource",
    "tags": ["sample", "test", "updated"],
    "metadata": {
      "category": "testing",
      "version": "1.1"
    },
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T12:00:00Z"
  },
  "message": "Resource updated successfully",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### 5. Delete Resource

**Endpoint:** `DELETE /resources/:id`

**Description:** Deletes a specific resource.

#### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Unique identifier of the resource |

#### Example Request

```http
DELETE /resources/123456 HTTP/1.1
Host: api.example.com
Authorization: Bearer YOUR_API_KEY
```

#### Success Response (200 OK)

```json
{
  "success": true,
  "data": null,
  "message": "Resource deleted successfully",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## Rate Limiting

The API has rate limits to prevent abuse:

- **Free Tier:** 100 requests per minute per API key
- **Pro Tier:** 1000 requests per minute per API key
- **Enterprise Tier:** Custom limits available

When you approach the rate limit, you will receive a `429 Too Many Requests` response with a `Retry-After` header indicating the number of seconds to wait before making more requests.

## Error Handling

All API endpoints follow a consistent error format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "field": "invalid_value"
    }
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## Webhooks

The API supports webhooks for real-time notifications about events:

### Available Events

- `resource.created` - Fires when a new resource is created
- `resource.updated` - Fires when a resource is updated
- `resource.deleted` - Fires when a resource is deleted

### Webhook Configuration

You can configure webhooks from your account settings. Each webhook includes:
- Target URL
- Events to listen for
- Secret token for verification

### Example Webhook Payload

```json
{
  "event": "resource.created",
  "data": {
    "id": "123456",
    "name": "Sample Resource",
    "created_at": "2024-01-01T00:00:00Z"
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## SDKs and Libraries

We provide official SDKs for popular programming languages:

- [JavaScript/TypeScript](https://github.com/example/api-js-sdk)
- [Python](https://github.com/example/api-python-sdk)
- [Java](https://github.com/example/api-java-sdk)
- [Go](https://github.com/example/api-go-sdk)

## Best Practices

### Error Handling

```javascript
// JavaScript example of error handling
try {
  const response = await fetch('https://api.example.com/v1/resources', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer YOUR_API_KEY'
    },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    const error = await response.json();
    console.error(`Error ${error.error.code}: ${error.error.message}`);
    if (error.error.details) {
      console.error('Details:', error.error.details);
    }
  }
  
  const result = await response.json();
  console.log('Success:', result);
} catch (error) {
  console.error('Network error:', error);
}
```

### Pagination

```python
# Python example of pagination
import requests

def fetch_all_resources(api_key):
    resources = []
    offset = 0
    limit = 100
    
    while True:
        response = requests.get(
            'https://api.example.com/v1/resources',
            params={'limit': limit, 'offset': offset},
            headers={'Authorization': f'Bearer {api_key}'}
        )
        
        data = response.json()
        resources.extend(data['data']['items'])
        
        if len(data['data']['items']) < limit:
            break
            
        offset += limit
        
    return resources

resources = fetch_all_resources('YOUR_API_KEY')
print(f'Found {len(resources)} resources')
```

## Testing

We provide a sandbox environment for testing your integration:

```
https://sandbox.api.example.com/v1
```

All requests to the sandbox environment are free and don't affect your production data.

## Support

For questions or issues:
- Check our [FAQ](https://example.com/faq)
- Visit our [developer forum](https://example.com/forum)
- Contact support at [dev-support@example.com](mailto:dev-support@example.com)

## Changelog

### v1.0.0 (2024-01-01)
- Initial release of the API
- Support for resource creation, retrieval, updating, and deletion
- Pagination support for list endpoints
- Rate limiting and webhook functionality