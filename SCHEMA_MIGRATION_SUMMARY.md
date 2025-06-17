# MCP Servers Schema Migration Summary

This document summarizes the updates made to the MCP servers to use the new DynamoDB schemas.

## Schema Changes

### Original Schema (Old)
- **Region**: us-west-2
- **Tables**: 
  - `slowik-flight-test`
  - `slowik-passenger-test`

### New Schema (Updated)
- **Region**: us-east-1
- **Tables**:
  - `Flights` - Flight information with StatusIndex GSI
  - `Passengers` - Passenger data with FrequentFlyerIndex GSI
  - `Bookings` - Booking records with multiple GSIs
  - `DelayNotifications` - Delay notification tracking
  - `RebookingOptions` - Alternative flight options
  - `CustomerSupportSessions` - Support interaction tracking
  - `PassengerPreferences` - User preferences

## Updated Files

### 1. flight-ops-server.js

#### Key Changes:
- **Region**: Updated from `us-west-2` to `us-east-1`
- **Table Names**: Updated to match new schema table names
- **Data Access Patterns**: 
  - Uses StatusIndex GSI for efficient delay queries
  - Leverages FlightBookingsIndex for passenger lookups
  - Updated field names to match schema (PascalCase)

#### New Features:
- Enhanced test connection that checks all tables
- Better error handling and debugging
- Improved query efficiency using GSIs

#### Field Mappings:
```javascript
// Old -> New
flight.flightNumber -> flight.FlightNumber
flight.origin -> flight.Origin  
flight.destination -> flight.Destination
flight.status -> flight.Status
flight.delayMinutes -> flight.DelayMinutes
flight.departure -> flight.ScheduledDepartureTime
flight.arrival -> flight.ScheduledArrivalTime
```

### 2. customer-service-server.js

#### Key Changes:
- **Region**: Updated from `us-west-2` to `us-east-1`
- **Table Names**: Updated to match new schema
- **Enhanced Functionality**: Added new tools for notifications and support sessions

#### New Tools Added:
1. **create_delay_notification**
   - Creates tracking records in DelayNotifications table
   - Supports multiple notification types (SMS, email, push, call)
   
2. **start_support_session**
   - Initiates customer support sessions
   - Tracks interactions in CustomerSupportSessions table

#### Field Mappings:
```javascript
// Old -> New
passenger.id -> passenger.PassengerId
passenger.frequentFlyerTier -> passenger.FrequentFlyerTier
```

## Schema Structure Overview

### Key Features of New Schema:

1. **Primary Keys**:
   - Flights: FlightNumber (HASH) + ScheduledDepartureDate (RANGE)
   - Passengers: PassengerId (HASH) + BookingReference (RANGE)
   - Bookings: BookingReference (HASH) + PassengerId (RANGE)

2. **Global Secondary Indexes**:
   - StatusIndex on Flights for efficient delay queries
   - FrequentFlyerIndex on Passengers
   - FlightBookingsIndex on Bookings for passenger-flight lookups
   - PassengerNotificationsIndex on DelayNotifications
   - PassengerSessionsIndex on CustomerSupportSessions

3. **New Capabilities**:
   - Comprehensive delay notification tracking
   - Customer support session management
   - Enhanced passenger preference handling
   - Better rebooking option tracking

## Testing

A test script `test-updated-servers.js` has been created to verify:
- Database connectivity
- Tool functionality
- Schema compatibility
- Error handling

### Running Tests:
```bash
node test-updated-servers.js
```

## Migration Benefits

1. **Performance**: Uses GSIs for efficient queries instead of scans
2. **Scalability**: Better data modeling for high-volume operations
3. **Tracking**: Enhanced ability to track customer interactions
4. **Compliance**: Better audit trail for notifications and support
5. **Integration**: Structured for easier integration with other systems

## Next Steps

1. **Data Migration**: Migrate existing data from old tables to new schema
2. **Testing**: Run comprehensive tests with real data
3. **Monitoring**: Set up CloudWatch metrics for the new tables
4. **Documentation**: Update API documentation for new tools
5. **Deployment**: Deploy updated servers to production environment

## Compatibility Notes

- Both servers maintain backward compatibility for existing tool interfaces
- New tools are additive and don't break existing functionality
- Error messages have been improved for better debugging
- All string interpolations have been secured against object coercion

## Security Improvements

- Input validation enhanced
- String coercion issues resolved
- Better error boundary handling
- Sanitized database queries
