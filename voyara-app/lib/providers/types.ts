export interface FlightQuery {
  origin: string;
  destination: string;
  departOn: string;
  returnOn?: string;
  passengers: number;
  cabin?: 'economy' | 'premium_economy' | 'business' | 'first';
}

export interface FlightOffer {
  id: string;
  carrier: string;
  carrierName: string;
  segments: string;
  departAt: string;
  arriveAt: string;
  durationMinutes: number;
  stops: number;
  publicMinor: number;
  currency: string;
  bagIncluded: boolean;
  changeable: boolean;
  refundable: boolean;
  expiresAt: string | null;
}

export interface StayQuery {
  destination: string;
  checkIn: string;
  checkOut: string;
  guests: number;
}

export interface StayOffer {
  id: string;
  name: string;
  location: string;
  roomDescription: string;
  nights: number;
  publicMinor: number;
  currency: string;
  freeCancellationUntil: string | null;
  payAtProperty: boolean;
  taxesIncluded: boolean;
}

export interface FlightStatus {
  ident: string;
  status: string;
  scheduledOut: string | null;
  estimatedOut: string | null;
  scheduledIn: string | null;
  estimatedIn: string | null;
  delayMinutes: number;
  gate: string | null;
  terminal: string | null;
  observedAt: string;
}

export interface Provider {
  mode: 'live' | 'mock';
  name: string;
}
