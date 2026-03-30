import React, { useState, useEffect, useRef, useMemo, Component } from 'react';
import { 
  Bolt, 
  ArrowRight, 
  Zap, 
  MapPin, 
  Menu, 
  Search, 
  SlidersHorizontal, 
  LocateFixed, 
  Bookmark, 
  User, 
  Navigation, 
  PowerOff,
  UserCircle,
  CreditCard,
  Settings,
  HelpCircle,
  LogOut,
  Phone,
  CheckCircle2,
  Loader2,
  Languages,
  X,
  Layers
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db } from './firebase';
import { 
  RecaptchaVerifier, 
  signInWithPhoneNumber, 
  ConfirmationResult, 
  onAuthStateChanged,
  User as FirebaseUser,
  signOut
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp, collection, addDoc, query, getDocs, orderBy, Timestamp, getDocFromServer, onSnapshot } from 'firebase/firestore';
import { Language, translations } from './translations';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('ErrorBoundary caught an error', error, errorInfo);
  }

  render() {
    const { hasError, error } = (this as any).state;
    const { children } = (this as any).props;

    if (hasError) {
      const lang = (localStorage.getItem('socket_language') as Language) || 'en';
      const t = (key: string) => translations[lang][key as keyof typeof translations['en']] || key;

      let message = t('somethingWentWrong');
      try {
        const parsed = JSON.parse(error.message);
        if (parsed.error) message = `Firestore Error: ${parsed.error} (${parsed.operationType} at ${parsed.path})`;
      } catch (e) {
        message = error?.message || message;
      }

      return (
        <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-8 text-center">
          <div className="w-20 h-20 bg-error/20 rounded-full flex items-center justify-center mb-6">
            <Bolt className="text-error w-10 h-10" />
          </div>
          <h1 className="text-2xl font-headline font-bold mb-4 text-on-surface">{t('oops')}</h1>
          <p className="text-on-surface-variant mb-8 max-w-md">{message}</p>
          <button 
            onClick={() => window.location.reload()}
            className="bg-primary text-on-primary px-8 py-3 rounded-xl font-bold active:scale-95 transition-transform"
            aria-label={t('reloadApp')}
          >
            {t('reloadApp')}
          </button>
        </div>
      );
    }

    return children;
  }
}

type View = 'onboarding' | 'map' | 'charger-details' | 'search-filters' | 'saved' | 'booked' | 'payment' | 'payment-success' | 'profile' | 'admin';

interface Booking {
  chargerId: string;
  bookingFee: number;
  duration: number; // in seconds
  transactionId: string;
  expiryTime: number; // timestamp
}

interface PastBooking {
  id: string;
  chargerId: string;
  chargerName: string;
  bookingFee: number;
  duration: number;
  timestamp: Timestamp;
}

type ConnectorStatus = 'available' | 'busy' | 'offline';

interface Connector {
  type: string;
  status: ConnectorStatus;
}

interface Charger {
  id: string;
  name: string;
  nameAm: string;
  distance: string;
  time: string;
  power: number;
  status: 'AVAILABLE' | 'OCCUPIED' | 'OFFLINE';
  connectors: Connector[];
  price: string;
  priceAm: string;
  slots: string;
  slotsAm: string;
  lat: number;
  lng: number;
  vehicleType?: 'Electric' | 'Hybrid' | 'Gasoline';
  images?: string[];
}

import { MapContainer, TileLayer, Marker, Popup, useMap, ZoomControl } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';

// Fix Leaflet default icon issue
// import 'leaflet/dist/leaflet.css'; // Redundant, already in index.css

const createChargerIcon = (charger: Charger, isActive: boolean) => {
  const isFast = charger.power >= 50;
  const status = charger.status;
  
  // Status-based colors
  let bgColor = '#10B981'; // Green (Available)
  let iconColor = '#FFFFFF';
  let animationHtml = '';
  
  if (status === 'OFFLINE') {
    bgColor = '#6B7280'; // Gray
  } else if (status === 'OCCUPIED') {
    bgColor = '#F59E0B'; // Amber
  }

  // Animation for available chargers
  if (status === 'AVAILABLE') {
    animationHtml = `
      <div class="absolute -inset-2 rounded-full opacity-40 animate-ping" style="background-color: ${bgColor}"></div>
      <div class="absolute -inset-1 rounded-full opacity-20 animate-pulse" style="background-color: ${bgColor}"></div>
    `;
  }

  // Speed indicator
  const speedRing = isFast ? 'border-4 border-white/40' : 'border-2 border-white/20';

  const boltIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
  const clockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const powerOffIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;

  const iconHtml = status === 'AVAILABLE' ? boltIcon : status === 'OCCUPIED' ? clockIcon : powerOffIcon;

  return L.divIcon({
    className: 'custom-charger-icon',
    html: `
      <div class="relative flex items-center justify-center">
        ${animationHtml}
        <div class="w-11 h-11 rounded-full flex items-center justify-center shadow-2xl transition-all duration-500 ${speedRing} ${isActive ? 'scale-125 z-50 ring-4 ring-white' : ''} ${status === 'OFFLINE' ? 'opacity-80 grayscale-[0.5]' : ''}" 
             style="background-color: ${bgColor}; color: ${iconColor};">
          ${iconHtml}
        </div>
      </div>
    `,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
};

const createUserIcon = () => {
  return L.divIcon({
    className: 'user-location-icon',
    html: `
      <div class="relative flex items-center justify-center">
        <div class="absolute -inset-3 bg-blue-500/20 rounded-full animate-pulse"></div>
        <div class="w-5 h-5 bg-blue-500 rounded-full border-2 border-white shadow-lg"></div>
      </div>
    `,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
};

const MOCK_CHARGERS: Charger[] = [
  {
    id: '1',
    name: 'Bole Atlas Station',
    nameAm: 'ቦሌ አትላስ ጣቢያ',
    distance: '0.8 km',
    time: '3 min',
    power: 150,
    status: 'AVAILABLE',
    connectors: [
      { type: 'CCS2', status: 'available' },
      { type: 'Type 2', status: 'busy' }
    ],
    price: '12.50 ETB/kWh',
    priceAm: '12.50 ብር/ኪ.ዋ.ሰ',
    slots: '3/5 Available',
    slotsAm: '3/5 ክፍት',
    lat: 9.0125,
    lng: 38.7845,
    vehicleType: 'Electric'
  },
  {
    id: '2',
    name: 'Edna Mall Parking',
    nameAm: 'ኤድና ሞል ፓርኪንግ',
    distance: '1.4 km',
    time: '6 min',
    power: 22,
    status: 'OCCUPIED',
    connectors: [
      { type: 'Type 2', status: 'busy' }
    ],
    price: '10.00 ETB/kWh',
    priceAm: '10.00 ብር/ኪ.ዋ.ሰ',
    slots: '0/2 Available',
    slotsAm: '0/2 ክፍት',
    lat: 8.9985,
    lng: 38.7855,
    vehicleType: 'Electric'
  },
  {
    id: '3',
    name: 'Friendship Mall',
    nameAm: 'ፍሬንድሺፕ ሞል',
    distance: '1.2 km',
    time: '5 min',
    power: 50,
    status: 'AVAILABLE',
    connectors: [
      { type: 'CCS2', status: 'available' }
    ],
    price: '11.00 ETB/kWh',
    priceAm: '11.00 ብር/ኪ.ዋ.ሰ',
    slots: '1/1 Available',
    slotsAm: '1/1 ክፍት',
    lat: 8.9995,
    lng: 38.7865,
    vehicleType: 'Electric'
  },
  {
    id: '4',
    name: 'Hilton Hotel',
    nameAm: 'ሂልተን ሆቴል',
    distance: '2.5 km',
    time: '10 min',
    power: 150,
    status: 'AVAILABLE',
    connectors: [
      { type: 'CCS2', status: 'available' },
      { type: 'Type 2', status: 'available' }
    ],
    price: '15.00 ETB/kWh',
    priceAm: '15.00 ብር/ኪ.ዋ.ሰ',
    slots: '2/2 Available',
    slotsAm: '2/2 ክፍት',
    lat: 9.0215,
    lng: 38.7625,
    vehicleType: 'Hybrid'
  },
  {
    id: '5',
    name: 'Sheraton Addis',
    nameAm: 'ሸራተን አዲስ',
    distance: '2.8 km',
    time: '12 min',
    power: 120,
    status: 'AVAILABLE',
    connectors: [
      { type: 'CCS2', status: 'available' }
    ],
    price: '15.00 ETB/kWh',
    priceAm: '15.00 ብር/ኪ.ዋ.ሰ',
    slots: '1/1 Available',
    slotsAm: '1/1 ክፍት',
    lat: 9.0225,
    lng: 38.7635,
    vehicleType: 'Electric'
  },
  {
    id: '6',
    name: 'Addis Ababa Stadium',
    nameAm: 'አዲስ አበባ ስታዲየም',
    distance: '3.2 km',
    time: '15 min',
    power: 50,
    status: 'OFFLINE',
    connectors: [
      { type: 'Type 2', status: 'offline' }
    ],
    price: '10.50 ETB/kWh',
    priceAm: '10.50 ብር/ኪ.ዋ.ሰ',
    slots: '0/1 Available',
    slotsAm: '0/1 ክፍት',
    lat: 9.0155,
    lng: 38.7555,
    vehicleType: 'Electric'
  }
];

export default function App() {
  const [view, setView] = useState<View>('onboarding');
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem('socket_language');
    return (saved as Language) || 'en';
  });

  useEffect(() => {
    localStorage.setItem('socket_language', language);
  }, [language]);
  const [selectedCharger, setSelectedCharger] = useState<Charger | null>(null);
  const [chargers, setChargers] = useState<Charger[]>(MOCK_CHARGERS);

  // Sync selectedCharger with chargers state
  useEffect(() => {
    if (selectedCharger) {
      const updated = chargers.find(c => c.id === selectedCharger.id);
      if (updated && (updated.status !== selectedCharger.status || updated.slots !== selectedCharger.slots)) {
        setSelectedCharger(updated);
      }
    }
  }, [chargers, selectedCharger]);

  const [favorites, setFavorites] = useState<string[]>(['1']);
  const [activeBooking, setActiveBooking] = useState<Booking | null>(null);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [pastBookings, setPastBookings] = useState<PastBooking[]>([]);
  const [isFetchingHistory, setIsFetchingHistory] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<[number, number]>([9.0125, 38.7625]);

  const MapController = ({ center }: { center: [number, number] }) => {
    const map = useMap();
    useEffect(() => {
      map.setView(center, map.getZoom(), { animate: true });
    }, [center, map]);
    return null;
  };

  const MapBoundsFilter = () => {
    const map = useMap();
    
    const updateVisibleChargers = React.useCallback(() => {
      const bounds = map.getBounds();
      const visible = filteredChargers.filter(charger => 
        bounds.contains([charger.lat, charger.lng])
      );
      setVisibleChargers(visible);
    }, [map, filteredChargers]);

    useEffect(() => {
      updateVisibleChargers();
      map.on('moveend zoomend', updateVisibleChargers);
      return () => {
        map.off('moveend zoomend', updateVisibleChargers);
      };
    }, [map, updateVisibleChargers]);

    return null;
  };

  const AdminView = () => {
    const [newStation, setNewStation] = useState({
      name: '',
      nameAm: '',
      lat: 9.0125,
      lng: 38.7625,
      power: 50,
      price: '12.50 ETB/kWh',
      priceAm: '12.50 ብር/ኪ.ዋ.ሰ',
      vehicleType: 'Electric' as const,
      numChargers: 1,
      images: [] as string[],
      imageUrl: ''
    });

    const handleAddStation = async () => {
      if (!newStation.name || !newStation.lat || !newStation.lng) {
        setToast('Please fill required fields');
        return;
      }

      setIsLoading(true);
      try {
        const stationId = Math.random().toString(36).substr(2, 9);
        const stationData: Charger = {
          id: stationId,
          name: newStation.name,
          nameAm: newStation.nameAm || newStation.name,
          lat: Number(newStation.lat),
          lng: Number(newStation.lng),
          power: Number(newStation.power),
          status: 'AVAILABLE',
          slots: `${newStation.numChargers}/${newStation.numChargers} Available`,
          slotsAm: `${newStation.numChargers}/${newStation.numChargers} ክፍት`,
          distance: '0 km',
          time: '0 min',
          price: newStation.price,
          priceAm: newStation.priceAm,
          vehicleType: newStation.vehicleType as any,
          images: newStation.images,
          connectors: Array(newStation.numChargers).fill(0).map(() => ({ type: 'CCS2', status: 'available' }))
        };

        await setDoc(doc(db, 'stations', stationId), stationData);
        setToast('Station added successfully');
        setView('map');
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'stations');
      } finally {
        setIsLoading(false);
      }
    };

    return (
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex-1 flex flex-col bg-surface p-6 overflow-y-auto"
      >
        <header className="flex items-center justify-between mb-8">
          <button onClick={() => setView('map')} className="p-2 bg-surface-container rounded-full">
            <ArrowRight className="w-6 h-6 rotate-180" />
          </button>
          <h2 className="text-xl font-bold">Admin: Add Station</h2>
          <div className="w-10" />
        </header>

        <div className="space-y-6 max-w-md mx-auto w-full">
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Station Name</label>
            <input 
              value={newStation.name}
              onChange={e => setNewStation({...newStation, name: e.target.value})}
              className="w-full bg-surface-container p-4 rounded-xl border border-white/5 focus:border-primary outline-none"
              placeholder="e.g. Bole Atlas Station"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Latitude</label>
              <input 
                type="number"
                value={newStation.lat}
                onChange={e => setNewStation({...newStation, lat: Number(e.target.value)})}
                className="w-full bg-surface-container p-4 rounded-xl border border-white/5 focus:border-primary outline-none"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Longitude</label>
              <input 
                type="number"
                value={newStation.lng}
                onChange={e => setNewStation({...newStation, lng: Number(e.target.value)})}
                className="w-full bg-surface-container p-4 rounded-xl border border-white/5 focus:border-primary outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Power (kW)</label>
              <input 
                type="number"
                value={newStation.power}
                onChange={e => setNewStation({...newStation, power: Number(e.target.value)})}
                className="w-full bg-surface-container p-4 rounded-xl border border-white/5 focus:border-primary outline-none"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Num Chargers</label>
              <input 
                type="number"
                value={newStation.numChargers}
                onChange={e => setNewStation({...newStation, numChargers: Number(e.target.value)})}
                className="w-full bg-surface-container p-4 rounded-xl border border-white/5 focus:border-primary outline-none"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Station Images (URLs)</label>
            <div className="flex gap-2">
              <input 
                value={newStation.imageUrl}
                onChange={e => setNewStation({...newStation, imageUrl: e.target.value})}
                className="flex-1 bg-surface-container p-4 rounded-xl border border-white/5 focus:border-primary outline-none"
                placeholder="https://..."
              />
              <button 
                onClick={() => {
                  if (newStation.imageUrl) {
                    setNewStation({
                      ...newStation, 
                      images: [...newStation.images, newStation.imageUrl],
                      imageUrl: ''
                    });
                  }
                }}
                className="bg-primary text-on-primary px-4 rounded-xl font-bold"
              >
                Add
              </button>
            </div>
            <div className="flex gap-2 overflow-x-auto py-2">
              {newStation.images.map((img, i) => (
                <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden flex-shrink-0">
                  <img src={img} className="w-full h-full object-cover" />
                  <button 
                    onClick={() => setNewStation({...newStation, images: newStation.images.filter((_, idx) => idx !== i)})}
                    className="absolute top-0 right-0 bg-error text-white p-1 rounded-bl-lg"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button 
            onClick={handleAddStation}
            disabled={isLoading}
            className="w-full bg-primary text-on-primary p-5 rounded-2xl font-bold shadow-xl active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : <Zap className="w-6 h-6" />}
            Save Station
          </button>
        </div>
      </motion.div>
    );
  };

  const SideMenu = () => (
    <AnimatePresence>
      {isMenuOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsMenuOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
          />
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed inset-y-0 left-0 w-72 bg-surface-container z-[201] shadow-2xl border-r border-white/5 flex flex-col"
          >
            <div className="p-8 border-b border-white/5">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center text-on-primary">
                  <Bolt className="w-6 h-6" />
                </div>
                <span className="text-xl font-headline font-black italic tracking-tighter text-primary">SOCKET</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-surface-container-highest flex items-center justify-center border border-white/10 overflow-hidden">
                  {user?.photoURL ? (
                    <img src={user.photoURL} alt="User" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <User className="w-6 h-6 text-on-surface-variant" />
                  )}
                </div>
                <div>
                  <p className="font-bold text-sm truncate w-32">{user?.displayName || 'EV Driver'}</p>
                  <p className="text-[10px] text-on-surface-variant truncate w-32">{user?.phoneNumber || 'No phone'}</p>
                </div>
              </div>
            </div>

            <nav className="flex-1 p-4 space-y-2">
              <button 
                onClick={() => { setView('map'); setIsMenuOpen(false); }}
                className={`w-full p-4 rounded-xl flex items-center gap-4 transition-colors ${view === 'map' ? 'bg-primary/10 text-primary' : 'hover:bg-white/5 text-on-surface-variant'}`}
              >
                <MapPin className="w-5 h-5" />
                <span className="font-bold text-sm">{t('map')}</span>
              </button>
              <button 
                onClick={() => { setView('saved'); setIsMenuOpen(false); }}
                className={`w-full p-4 rounded-xl flex items-center gap-4 transition-colors ${view === 'saved' ? 'bg-primary/10 text-primary' : 'hover:bg-white/5 text-on-surface-variant'}`}
              >
                <Bookmark className="w-5 h-5" />
                <span className="font-bold text-sm">{t('saved')}</span>
              </button>
              <button 
                onClick={() => { setView('profile'); setIsMenuOpen(false); }}
                className={`w-full p-4 rounded-xl flex items-center gap-4 transition-colors ${view === 'profile' ? 'bg-primary/10 text-primary' : 'hover:bg-white/5 text-on-surface-variant'}`}
              >
                <User className="w-5 h-5" />
                <span className="font-bold text-sm">{t('profile')}</span>
              </button>
              
              {isAdmin && (
                <>
                  <div className="h-px bg-white/5 my-4 mx-4"></div>
                  <button 
                    onClick={() => { setView('admin'); setIsMenuOpen(false); }}
                    className={`w-full p-4 rounded-xl flex items-center gap-4 transition-colors ${view === 'admin' ? 'bg-primary/10 text-primary' : 'hover:bg-white/5 text-on-surface-variant'}`}
                  >
                    <Settings className="w-5 h-5" />
                    <span className="font-bold text-sm">Admin Dashboard</span>
                  </button>
                </>
              )}

              <div className="h-px bg-white/5 my-4 mx-4"></div>
              <button 
                onClick={() => { setToast(t('comingSoon')); setIsMenuOpen(false); }}
                className="w-full p-4 rounded-xl flex items-center gap-4 text-on-surface-variant hover:bg-white/5 transition-colors"
              >
                <Settings className="w-5 h-5" />
                <span className="font-bold text-sm">{t('settings')}</span>
              </button>
              <button 
                onClick={() => { setToast(t('comingSoon')); setIsMenuOpen(false); }}
                className="w-full p-4 rounded-xl flex items-center gap-4 text-on-surface-variant hover:bg-white/5 transition-colors"
              >
                <HelpCircle className="w-5 h-5" />
                <span className="font-bold text-sm">{t('help')}</span>
              </button>
            </nav>

            <div className="p-4 border-t border-white/5">
              <button 
                onClick={() => { handleSignOut(); setIsMenuOpen(false); }}
                className="w-full p-4 rounded-xl flex items-center gap-4 text-error hover:bg-error/10 transition-colors"
              >
                <LogOut className="w-5 h-5" />
                <span className="font-bold text-sm">{t('signOut')}</span>
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  useEffect(() => {
    // Randomize battery level for realism on mount
    setBatteryLevel(Math.floor(Math.random() * 40) + 40);
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const [searchQuery, setSearchQuery] = useState('');
  const [vehicleTypeFilter, setVehicleTypeFilter] = useState<'Electric' | 'Hybrid' | 'Gasoline' | 'All'>('All');
  const [selectedChargerTypes, setSelectedChargerTypes] = useState<string[]>([]);
  const [distanceFilter, setDistanceFilter] = useState(50);
  const [availableNowOnly, setAvailableNowOnly] = useState(false);
  const [showBookingConfirmation, setShowBookingConfirmation] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [visibleChargers, setVisibleChargers] = useState<Charger[]>([]);
  const [mapStyle, setMapStyle] = useState<'light' | 'satellite' | 'terrain'>('light');
  const [showLayerControl, setShowLayerControl] = useState(false);

  const mapStyles = {
    light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    terrain: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
  };

  const filteredChargers = React.useMemo(() => {
    return chargers.filter(charger => {
      // Search query
      const matchesSearch = 
        charger.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        charger.nameAm.toLowerCase().includes(searchQuery.toLowerCase()) ||
        charger.power.toString().includes(searchQuery);
      
      if (!matchesSearch) return false;

      // Status filter
      if (availableNowOnly && charger.status !== 'AVAILABLE') return false;

      // Charger type filter
      if (selectedChargerTypes.length > 0) {
        const hasMatchingType = charger.connectors.some(c => selectedChargerTypes.includes(c.type));
        if (!hasMatchingType) return false;
      }

      // Distance filter (mock distance parsing)
      const dist = parseFloat(charger.distance.split(' ')[0]);
      if (dist > distanceFilter) return false;

      // Vehicle type filter
      if (vehicleTypeFilter !== 'All' && charger.vehicleType !== vehicleTypeFilter) return false;

      return true;
    });
  }, [chargers, searchQuery, availableNowOnly, selectedChargerTypes, distanceFilter, vehicleTypeFilter]);

  const [activePinId, setActivePinId] = useState<string | null>(null);
  const [batteryLevel, setBatteryLevel] = useState(84);

  const t = (key: keyof typeof translations['en']) => translations[language][key] || key;

  const toggleLanguage = () => {
    setLanguage(prev => prev === 'en' ? 'am' : 'en');
  };

  // Real-time stations listener
  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'stations'), (snapshot) => {
      const stationsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Charger[];
      
      if (stationsData.length > 0) {
        setChargers(stationsData);
      } else {
        // Fallback to mock data if collection is empty
        setChargers(MOCK_CHARGERS);
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'stations');
    });
    
    return () => unsubscribe();
  }, []);

  // Auth State
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authStep, setAuthStep] = useState<'initial' | 'phone' | 'otp'>('initial');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState(false);
  const recaptchaRef = useRef<HTMLDivElement>(null);
  const recaptchaVerifier = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        setConfigError(false);
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
          setConfigError(true);
        }
      }
    };
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Check for admin role
        try {
          const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
          if (userDoc.exists() && userDoc.data().role === 'admin') {
            setIsAdmin(true);
          } else if (currentUser.email === "shemelesfani@gmail.com") {
            setIsAdmin(true);
          } else {
            setIsAdmin(false);
          }
        } catch (err) {
          console.error('Failed to check admin status', err);
        }
        setView('map');
      } else {
        setView('onboarding');
        setAuthStep('initial');
        setIsAdmin(false);
      }
    });
    return () => unsubscribe();
  }, []);

  const setupRecaptcha = () => {
    if (recaptchaVerifier.current) return;
    try {
      recaptchaVerifier.current = new RecaptchaVerifier(auth, 'recaptcha-container', {
        size: 'invisible',
        callback: () => {
          console.log('Recaptcha resolved');
        }
      });
    } catch (err) {
      console.error('Recaptcha setup failed', err);
    }
  };

  const handleSendOTP = async () => {
    if (!phoneNumber.startsWith('0') || phoneNumber.length !== 10) {
      setError('Please enter a valid 10-digit Ethiopian phone number starting with 0');
      return;
    }

    setIsLoading(true);
    setError(null);

    // Developer Test Bypass
    if (phoneNumber === '0901001969') {
      setTimeout(() => {
        setIsLoading(false);
        setAuthStep('otp');
      }, 1000);
      return;
    }

    setupRecaptcha();

    try {
      const formattedPhone = `+251${phoneNumber.substring(1)}`;
      const result = await signInWithPhoneNumber(auth, formattedPhone, recaptchaVerifier.current!);
      setConfirmationResult(result);
      setAuthStep('otp');
    } catch (err: any) {
      console.error('Failed to send OTP', err);
      if (err.code === 'auth/operation-not-allowed') {
        setError('Phone authentication is not enabled in the Firebase Console. Please enable it in the "Sign-in method" tab.');
      } else {
        setError(err.message || 'Failed to send OTP. Please try again.');
      }
      if (recaptchaVerifier.current) {
        recaptchaVerifier.current.clear();
        recaptchaVerifier.current = null;
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (otp.length !== 6) {
      setError('Please enter the 6-digit code');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      let loggedUser: FirebaseUser;

      // Developer Test Bypass
      if (phoneNumber === '0901001969' && otp === '123456') {
        // Simulate a logged in user for testing
        loggedUser = {
          uid: 'test-user-123',
          phoneNumber: '+251901001969',
          displayName: 'Test User',
          email: 'test@example.com',
          emailVerified: true,
          isAnonymous: false,
          metadata: {},
          providerData: [],
          refreshToken: '',
          tenantId: null,
          delete: async () => {},
          getIdToken: async () => '',
          getIdTokenResult: async () => ({} as any),
          reload: async () => {},
          toJSON: () => ({})
        } as any;
      } else {
        const result = await confirmationResult!.confirm(otp);
        loggedUser = result.user;
      }
      
      // Check if user exists in Firestore
      const userPath = `users/${loggedUser.uid}`;
      let userDoc;
      try {
        userDoc = await getDoc(doc(db, 'users', loggedUser.uid));
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, userPath);
      }

      if (!userDoc.exists()) {
        try {
          await setDoc(doc(db, 'users', loggedUser.uid), {
            uid: loggedUser.uid,
            phoneNumber: loggedUser.phoneNumber,
            createdAt: serverTimestamp(),
            displayName: loggedUser.displayName || `User ${loggedUser.phoneNumber?.slice(-4)}`
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, userPath);
        }
      }
      
      setUser(loggedUser);
      setView('map');
    } catch (err: any) {
      console.error('Failed to verify OTP', err);
      setError('Invalid code. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setView('onboarding');
      setAuthStep('initial');
    } catch (err) {
      console.error('Sign out failed', err);
    }
  };

  const toggleFavorite = (id: string) => {
    setFavorites(prev => prev.includes(id) ? prev.filter(f => f !== id) : [...prev, id]);
  };

  const handleChargerClick = (charger: Charger) => {
    setSelectedCharger(charger);
    setActivePinId(null);
    setView('charger-details');
  };

  const handleNavigate = (charger?: Charger) => {
    const target = charger || selectedCharger;
    if (!target) return;
    const { lat, lng } = target;
    
    // Use a universal Google Maps directions link
    const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    
    // Platform detection
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    
    if (isIOS) {
      // Apple Maps link
      const appleUrl = `maps://?daddr=${lat},${lng}`;
      window.location.href = appleUrl;
      
      // Fallback to Google Maps web if Apple Maps doesn't respond (unlikely on iOS)
      setTimeout(() => {
        if (document.visibilityState === 'visible') {
          window.open(googleUrl, '_blank');
        }
      }, 2000);
    } else {
      // Open Google Maps (will open app if installed, otherwise browser)
      window.open(googleUrl, '_blank');
    }
  };

  const handleLocateUser = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          setUserLocation([latitude, longitude]);
          setToast(t('locationUpdated') || 'Location updated');
        },
        (error) => {
          console.error("Error getting location:", error);
          setToast(t('locationError') || 'Could not get location');
          // Fallback to default Addis Ababa center
          setUserLocation([9.0125, 38.7625]);
        }
      );
    } else {
      setToast(t('locationNotSupported') || 'Geolocation not supported');
    }
  };

  const handleBookCharger = () => {
    if (!selectedCharger) return;
    setShowBookingConfirmation(true);
  };

  const confirmBooking = () => {
    if (!selectedCharger) return;
    const bookingDuration = 30 * 60; // 30 minutes in seconds
    setActiveBooking({
      chargerId: selectedCharger.id,
      bookingFee: 50, // Fixed booking fee
      duration: bookingDuration,
      transactionId: `BOK-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
      expiryTime: Date.now() + bookingDuration * 1000
    });
    setShowBookingConfirmation(false);
    setView('booked');
  };

  const handleCancelBooking = () => {
    setActiveBooking(null);
    setView('map');
  };

  const handlePayment = async () => {
    if (!user || !activeBooking || !selectedCharger) return;
    
    setIsProcessingPayment(true);
    
    try {
      // Simulate payment processing
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Save booking to Firestore
      const bookingPath = `users/${user.uid}/bookings`;
      const bookingData = {
        chargerId: activeBooking.chargerId,
        chargerName: selectedCharger.name,
        bookingFee: activeBooking.bookingFee,
        duration: activeBooking.duration,
        timestamp: serverTimestamp()
      };
      
      try {
        await addDoc(collection(db, 'users', user.uid, 'bookings'), bookingData);
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, bookingPath);
      }
      
      setActiveBooking(null);
      setIsProcessingPayment(false);
      setView('payment-success');
    } catch (err) {
      console.error('Payment/Saving failed', err);
      setIsProcessingPayment(false);
      setError('Payment failed. Please try again.');
    }
  };

  useEffect(() => {
    const fetchHistory = async () => {
      if (!user || view !== 'profile') return;
      
      setIsFetchingHistory(true);
      const historyPath = `users/${user.uid}/bookings`;
      try {
        const q = query(
          collection(db, 'users', user.uid, 'bookings'),
          orderBy('timestamp', 'desc')
        );
        const querySnapshot = await getDocs(q);
        const bookings: PastBooking[] = [];
        querySnapshot.forEach((doc) => {
          const data = doc.data();
          bookings.push({ 
            id: doc.id, 
            ...data,
            timestamp: data.timestamp?.toDate?.()?.toISOString() || new Date().toISOString()
          } as PastBooking);
        });
        setPastBookings(bookings);
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, historyPath);
      } finally {
        setIsFetchingHistory(false);
      }
    };
    
    fetchHistory();
  }, [user, view]);

  const { totalSpent, totalBookingsCount, totalHours } = React.useMemo(() => {
    return {
      totalSpent: pastBookings.reduce((acc, s) => acc + (s.bookingFee || 0), 0),
      totalBookingsCount: pastBookings.length,
      totalHours: pastBookings.reduce((acc, s) => acc + (s.duration || 0), 0) / 3600
    };
  }, [pastBookings]);

  const isSubPage = ['charger-details', 'search-filters', 'booked', 'payment', 'payment-success'].includes(view);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (view === 'booked' && activeBooking) {
      interval = setInterval(() => {
        setActiveBooking(prev => {
          if (!prev) return null;
          const newDuration = Math.max(0, prev.duration - 1);
          if (newDuration === 0) {
            // Auto-cancel booking if time expires
            setView('map');
            return null;
          }
          return {
            ...prev,
            duration: newDuration
          };
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [view, activeBooking]);

  return (
    <ErrorBoundary>
      <div className="relative min-h-screen overflow-hidden bg-surface selection:bg-primary-container selection:text-on-primary-container">
      {/* Configuration Error Banner */}
      <AnimatePresence>
        {configError && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="fixed top-0 left-0 right-0 z-[3000] bg-error text-on-error px-6 py-3 flex items-center justify-between shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <HelpCircle className="w-5 h-5 animate-pulse" />
              <div className="flex flex-col">
                <span className="font-bold text-sm">Firebase Configuration Error</span>
                <span className="text-xs opacity-90">The app is currently offline or misconfigured. Please check your Firebase setup.</span>
              </div>
            </div>
            <button 
              onClick={() => setConfigError(false)}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[200] bg-surface-container-highest border border-white/10 px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3"
          >
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary">
              <Bolt className="w-4 h-4" />
            </div>
            <span className="font-bold text-sm">{toast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <SideMenu />

      <AnimatePresence mode="wait">
        {view === 'admin' ? (
          <AdminView />
        ) : view === 'onboarding' ? (
          <motion.div
            key="onboarding"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="relative min-h-screen flex flex-col"
          >
            {/* Hero Visual Background */}
            <div className="fixed inset-0 z-0 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-surface/40 to-surface z-10"></div>
              <div 
                className="absolute inset-0 opacity-40 scale-110 bg-cover bg-center"
                style={{ 
                  backgroundImage: "url('https://lh3.googleusercontent.com/aida-public/AB6AXuDFb60Vufo-OVTjvWIq5qwnJPD7iwk7FIDWwvMQsQMuwkR7XT9X55VeSTgkG2FvBRV_n82AOQ1TfYb9_sjEMObq1IPpS07_SCv6DLYMdqFXDOs1Og2igex-8TE2lt4-C18BnF4E6YylWc4VficFuYCyqbgc4plq_-DsXiM22DXfwbNezaGkEJS8PprS7Vm8ZZSuMb_hb_J-BqqyTDxeMXD83PxTkN4ERJ58IOlO1b9AG36OWe9fblPz0O9C7Gd1h98NdRewgzgEIPHD')" 
                }}
              ></div>
            </div>

            {/* Onboarding Container */}
            <main className="relative z-20 flex-1 flex flex-col justify-between px-8 pt-16 pb-12">
              {/* Branding Section */}
              <motion.header 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-primary rounded-lg flex items-center justify-center shadow-[0_0_24px_rgba(77,253,157,0.3)]">
                      <Bolt className="text-on-primary w-8 h-8" strokeWidth={3} />
                    </div>
                    <div>
                      <h1 className="font-headline font-black italic tracking-tighter text-4xl text-primary leading-none">
                        {t('appName')}
                      </h1>
                      <span className="text-on-surface-variant font-headline text-lg tracking-widest opacity-80 amharic-text">
                        {language === 'en' ? 'ሶኬት' : 'Socket'}
                      </span>
                    </div>
                  </div>
                  <button 
                    onClick={toggleLanguage}
                    className="w-12 h-12 bg-surface-container rounded-full flex items-center justify-center active:scale-95 transition-all"
                  >
                    <Languages className="text-primary w-6 h-6" />
                  </button>
                </div>
              </motion.header>

              {/* Kinetic Content Section */}
              <section className="flex flex-col gap-8 max-w-md">
                <motion.div 
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.8, delay: 0.2 }}
                  className="space-y-4"
                >
                  <div className="flex flex-col">
                    <h2 className="font-headline font-extrabold text-5xl md:text-6xl tracking-tight leading-[1.1]">
                      {t('onboardingTitle')}
                    </h2>
                    {language === 'en' && (
                      <p className="font-headline font-bold text-2xl text-primary-fixed-dim mt-2 amharic-text">
                        {t('onboardingAmharicSubtitle')}
                      </p>
                    )}
                  </div>
                  <p className="text-on-surface-variant text-lg leading-relaxed max-w-[90%]">
                    {t('onboardingSubtitle')}
                  </p>
                </motion.div>

                {/* Benefit Bento Mini-Grid */}
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.6, delay: 0.4 }}
                  className="grid grid-cols-2 gap-3"
                >
                  <div className="bg-surface-container p-4 rounded-lg flex flex-col gap-2">
                    <Zap className="text-primary w-6 h-6" />
                    <p className="text-sm font-semibold">{t('ultraFast')}</p>
                  </div>
                  <div className="bg-surface-container p-4 rounded-lg flex flex-col gap-2">
                    <MapPin className="text-tertiary w-6 h-6" />
                    <p className="text-sm font-semibold">{t('locations')}</p>
                  </div>
                </motion.div>
              </section>

              {/* Action Section */}
              <footer className="flex flex-col gap-6">
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 0.6 }}
                  className="flex flex-col gap-4"
                >
                  <div id="recaptcha-container"></div>
                  
                  {authStep === 'initial' && (
                    <>
                      <button 
                        onClick={() => setAuthStep('phone')}
                        className="w-full bg-gradient-to-br from-primary to-primary-container h-16 rounded-xl flex items-center justify-center gap-3 group active:scale-95 transition-all shadow-lg cursor-pointer"
                      >
                        <span className="text-on-primary font-headline font-bold text-lg text-glow">{t('getStarted')}</span>
                        <ArrowRight className="text-on-primary group-hover:translate-x-1 transition-transform w-6 h-6" />
                      </button>
                      <button 
                        onClick={() => setAuthStep('phone')}
                        className="w-full bg-surface-container-highest/40 backdrop-blur-md h-16 rounded-xl flex items-center justify-center active:scale-95 transition-all cursor-pointer"
                      >
                        <span className="text-on-surface font-headline font-semibold">{t('loginSignUp')}</span>
                      </button>
                    </>
                  )}

                  {authStep === 'phone' && (
                    <div className="flex flex-col gap-4">
                      <div className="relative">
                        <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant w-5 h-5" />
                        <input 
                          type="tel"
                          inputMode="tel"
                          pattern="[0-9]*"
                          placeholder={t('phonePlaceholder')}
                          value={phoneNumber}
                          onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
                          className="w-full h-16 bg-surface-container border border-white/10 rounded-xl pl-12 pr-4 text-lg font-bold focus:border-primary outline-none transition-all"
                        />
                      </div>
                      {error && <p className="text-error text-sm font-medium px-2">{error}</p>}
                      <button 
                        onClick={handleSendOTP}
                        disabled={isLoading || phoneNumber.length !== 10}
                        className="w-full bg-primary text-on-primary h-16 rounded-xl font-bold text-lg flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95 transition-all"
                      >
                        {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : t('sendCode')}
                      </button>
                      <button 
                        onClick={() => setAuthStep('initial')}
                        className="text-on-surface-variant text-sm font-bold uppercase tracking-widest text-center"
                      >
                        {t('back')}
                      </button>
                    </div>
                  )}

                  {authStep === 'otp' && (
                    <div className="flex flex-col gap-4">
                      <div className="relative">
                        <CheckCircle2 className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant w-5 h-5" />
                        <input 
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          placeholder={t('otpPlaceholder')}
                          value={otp}
                          onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          className="w-full h-16 bg-surface-container border border-white/10 rounded-xl pl-12 pr-4 text-lg font-bold tracking-[0.5em] focus:border-primary outline-none transition-all text-center"
                        />
                      </div>
                      {error && <p className="text-error text-sm font-medium px-2">{error}</p>}
                      <button 
                        onClick={handleVerifyOTP}
                        disabled={isLoading || otp.length !== 6}
                        className="w-full bg-primary text-on-primary h-16 rounded-xl font-bold text-lg flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95 transition-all"
                      >
                        {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : t('verifyContinue')}
                      </button>
                      <button 
                        onClick={() => setAuthStep('phone')}
                        className="text-on-surface-variant text-sm font-bold uppercase tracking-widest text-center"
                      >
                        {t('changeNumber')}
                      </button>
                    </div>
                  )}
                </motion.div>

                <div className="flex justify-center items-center gap-8">
                  <div className="w-1.5 h-1.5 bg-primary rounded-full"></div>
                  <div className="w-1.5 h-1.5 bg-on-surface-variant/30 rounded-full"></div>
                  <div className="w-1.5 h-1.5 bg-on-surface-variant/30 rounded-full"></div>
                </div>
              </footer>
            </main>
          </motion.div>
        ) : view === 'map' ? (
          <motion.div
            key="map"
            initial={{ opacity: 0, scale: 0.95, filter: 'blur(5px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 1.05, filter: 'blur(5px)' }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="relative h-screen w-full flex flex-col bg-surface overflow-hidden"
          >
            {/* Ambient Background Animation */}
            <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
              <motion.div
                className="absolute -top-[20%] -left-[10%] w-[70%] h-[70%] rounded-full"
                animate={{
                  opacity: [0.03, 0.08, 0.03],
                  scale: [1, 1.1, 1],
                  x: [0, 30, 0],
                  y: [0, 20, 0],
                }}
                transition={{
                  duration: 20,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
                style={{
                  background: 'radial-gradient(circle, rgba(0, 255, 102, 0.15) 0%, transparent 70%)',
                  filter: 'blur(80px)'
                }}
              />
              <motion.div
                className="absolute -bottom-[10%] -right-[10%] w-[60%] h-[60%] rounded-full"
                animate={{
                  opacity: [0.02, 0.06, 0.02],
                  scale: [1.1, 1, 1.1],
                  x: [0, -40, 0],
                  y: [0, -30, 0],
                }}
                transition={{
                  duration: 25,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
                style={{
                  background: 'radial-gradient(circle, rgba(0, 255, 102, 0.1) 0%, transparent 70%)',
                  filter: 'blur(100px)'
                }}
              />
              <motion.div
                className="absolute top-[30%] left-[20%] w-[40%] h-[40%] rounded-full"
                animate={{
                  opacity: [0.01, 0.04, 0.01],
                  scale: [0.8, 1.2, 0.8],
                }}
                transition={{
                  duration: 15,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
                style={{
                  background: 'radial-gradient(circle, rgba(255, 255, 255, 0.05) 0%, transparent 70%)',
                  filter: 'blur(60px)'
                }}
              />
            </div>

            {/* TopAppBar */}
            <header className="fixed top-0 w-full z-50 bg-transparent backdrop-blur-xl flex justify-between items-center px-6 py-4">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setIsMenuOpen(true)}
                  className="p-2 rounded-full hover:bg-white/10 transition-colors active:scale-95 duration-200 cursor-pointer"
                >
                  <Menu className="text-primary w-6 h-6" />
                </button>
                <h1 className="text-primary font-black italic tracking-tighter text-2xl font-headline">{t('appName')}</h1>
              </div>
              <div className="flex items-center gap-3">
                <button 
                  onClick={toggleLanguage}
                  className="bg-surface-container rounded-full px-3 py-1.5 flex items-center gap-2 shadow-[0_0_32px_rgba(255,255,255,0.06)] active:scale-95 transition-all"
                >
                  <Languages className="text-primary w-4 h-4" />
                  <span className="text-xs font-bold text-on-surface-variant font-body uppercase">{language === 'en' ? 'AM' : 'EN'}</span>
                </button>
                <div className="bg-surface-container rounded-full px-3 py-1.5 flex items-center gap-2 shadow-[0_0_32px_rgba(255,255,255,0.06)]">
                  <span className={`w-2 h-2 rounded-full animate-pulse ${batteryLevel < 20 ? 'bg-error' : 'bg-primary'}`}></span>
                  <span className="text-xs font-medium text-on-surface-variant font-body">{batteryLevel}%</span>
                </div>
                <div 
                  onClick={() => setIsMenuOpen(true)}
                  className="w-10 h-10 rounded-full border-2 border-primary/20 overflow-hidden active:scale-95 duration-200 cursor-pointer"
                >
                  <img 
                    alt="Profile" 
                    src="https://lh3.googleusercontent.com/aida-public/AB6AXuAigvhGGZMT26UDsLvSBWyV-4uAjXTpFHidHRn0Ok4uH6BgwcPMp5RVdvmFF1RPVArNTmu5MXhZNRYS7DsuSaQCnNrjYh4-5TeyQPQoYVGJHWaUWQfLbHYJF2vw3JGBDNLuS2Pq3zhwBwXXxgZaUXgjKs-9IQ8wTq6utxoJgFgEk97BUanA7a95A6kBjXGJ_kWk2JB7soeQQxyQuvKdBi5A8OoY21u-JpG82dgBT16YEh0z0GlZi7ZLYJk_s2BwHZlliDLlFoWZ90PK" 
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>
            </header>

            {/* Main Map Canvas */}
            <main className="relative flex-1 w-full overflow-hidden">
              <MapContainer 
                center={userLocation} 
                zoom={13} 
                className="h-full w-full" 
                zoomControl={false}
                attributionControl={false}
                preferCanvas={true}
              >
                <TileLayer
                  url={mapStyles[mapStyle]}
                />
                <ZoomControl position="bottomright" />
                <MapController center={userLocation} />
                <MapBoundsFilter />
                
                <MarkerClusterGroup
                  chunkedLoading
                  maxClusterRadius={60}
                  spiderfyOnMaxZoom={true}
                  disableClusteringAtZoom={16}
                  iconCreateFunction={(cluster) => {
                    return L.divIcon({
                      html: `<div class="bg-primary text-on-primary w-10 h-10 rounded-full flex items-center justify-center font-bold shadow-lg border-2 border-surface">${cluster.getChildCount()}</div>`,
                      className: 'custom-cluster-icon',
                      iconSize: [40, 40],
                    });
                  }}
                >
                  {visibleChargers.map((charger) => (
                    <Marker 
                      key={charger.id} 
                      position={[charger.lat, charger.lng]} 
                      icon={createChargerIcon(charger, activePinId === charger.id)}
                      eventHandlers={{
                        click: () => {
                          setActivePinId(charger.id);
                          setSelectedCharger(charger);
                        },
                      }}
                    >
                      <Popup className="charger-popup">
                        <div className="p-2 min-w-[200px]">
                          <h3 className="font-bold text-lg mb-1">{language === 'am' ? charger.nameAm : charger.name}</h3>
                          <div className="flex items-center gap-2 mb-2">
                            <div className={`w-2 h-2 rounded-full ${charger.status === 'AVAILABLE' ? 'bg-primary' : charger.status === 'OCCUPIED' ? 'bg-warning' : 'bg-outline'}`}></div>
                            <span className="text-xs font-semibold uppercase tracking-wider">
                              {charger.status === 'AVAILABLE' ? t('available') : charger.status === 'OCCUPIED' ? t('occupied') : t('offline')}
                            </span>
                          </div>
                          <div className="space-y-1 text-sm text-on-surface-variant">
                            <p className="flex items-center gap-2"><Zap className="w-4 h-4" /> {charger.power}kW • {charger.connectors[0].type}</p>
                            <p className="flex items-center gap-2"><MapPin className="w-4 h-4" /> {charger.distance} • {charger.time}</p>
                            <p className="flex items-center gap-2"><CreditCard className="w-4 h-4" /> {language === 'am' ? charger.priceAm : charger.price}</p>
                          </div>
                          <div className="grid grid-cols-2 gap-2 mt-4">
                            <button 
                              onClick={() => handleChargerClick(charger)}
                              className="bg-surface-container-highest text-on-surface py-2 rounded-lg font-bold text-xs active:scale-95 transition-transform"
                            >
                              {t('viewDetails')}
                            </button>
                            <button 
                              onClick={() => handleNavigate(charger)}
                              className="bg-primary text-on-primary py-2 rounded-lg font-bold text-xs flex items-center justify-center gap-1 active:scale-95 transition-transform"
                            >
                              <Navigation className="w-3 h-3" /> {t('navigate')}
                            </button>
                          </div>
                        </div>
                      </Popup>
                    </Marker>
                  ))}
                </MarkerClusterGroup>
                <Marker position={userLocation} icon={createUserIcon()} />
              </MapContainer>

              {/* Floating Search Container */}
              <div className="absolute top-24 left-0 right-0 px-6 z-[1000]">
                <div className="w-full max-w-xl mx-auto flex items-center bg-surface-container-high/90 backdrop-blur-xl p-2 rounded-full shadow-2xl border border-white/5 focus-within:ring-1 focus-within:ring-primary/40">
                  <div className="flex items-center px-4">
                    <Search className="text-on-surface-variant w-5 h-5" />
                  </div>
                  <input 
                    id="search-input"
                    className="bg-transparent border-none focus:outline-none text-sm w-full py-2 font-body text-on-surface placeholder:text-on-surface-variant" 
                    placeholder={t('searchPlaceholder')} 
                    aria-label={t('searchPlaceholder')}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button 
                      onClick={() => setSearchQuery('')}
                      className="p-2 text-on-surface-variant hover:text-primary transition-colors active:scale-90"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                  <button 
                    onClick={() => setView('search-filters')}
                    className="bg-primary-container p-2 rounded-full text-on-primary-container active:scale-90 transition-transform cursor-pointer"
                  >
                    <SlidersHorizontal className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Legend */}
              <div className="absolute top-44 right-6 z-[1000] flex flex-col gap-2">
                <div className="bg-surface-container-highest/90 backdrop-blur-xl p-3 rounded-2xl border border-white/10 shadow-xl space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-[#10B981]"></div>
                    <span className="text-[10px] font-bold text-on-surface">{t('available')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-[#F59E0B]"></div>
                    <span className="text-[10px] font-bold text-on-surface">{t('occupied')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-[#6B7280]"></div>
                    <span className="text-[10px] font-bold text-on-surface">{t('offline')}</span>
                  </div>
                  <div className="w-full h-px bg-white/10"></div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full border-2 border-white/60 bg-surface"></div>
                    <span className="text-[10px] font-bold text-on-surface">DC {t('fast')}</span>
                  </div>
                </div>
              </div>

              {/* FAB for Current Location */}
              <div className="absolute bottom-96 right-6 z-[1000] flex flex-col gap-3">
                <div className="relative">
                  <button 
                    onClick={() => setShowLayerControl(!showLayerControl)}
                    className={`w-14 h-14 backdrop-blur-xl rounded-2xl flex items-center justify-center shadow-xl border border-white/10 active:scale-90 transition-all cursor-pointer group ${showLayerControl ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'}`}
                    title="Map Layers"
                  >
                    <Layers className="w-6 h-6" />
                  </button>
                  
                  <AnimatePresence>
                    {showLayerControl && (
                      <motion.div
                        initial={{ opacity: 0, x: 20, scale: 0.9 }}
                        animate={{ opacity: 1, x: -70, scale: 1 }}
                        exit={{ opacity: 0, x: 20, scale: 0.9 }}
                        className="absolute top-0 right-0 bg-surface-container-highest/90 backdrop-blur-xl p-2 rounded-2xl border border-white/10 shadow-2xl flex flex-col gap-2 min-w-[120px]"
                      >
                        <button 
                          onClick={() => { setMapStyle('light'); setShowLayerControl(false); }}
                          className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors ${mapStyle === 'light' ? 'bg-primary text-on-primary' : 'hover:bg-white/5 text-on-surface-variant'}`}
                        >
                          Light
                        </button>
                        <button 
                          onClick={() => { setMapStyle('satellite'); setShowLayerControl(false); }}
                          className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors ${mapStyle === 'satellite' ? 'bg-primary text-on-primary' : 'hover:bg-white/5 text-on-surface-variant'}`}
                        >
                          Satellite
                        </button>
                        <button 
                          onClick={() => { setMapStyle('terrain'); setShowLayerControl(false); }}
                          className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors ${mapStyle === 'terrain' ? 'bg-primary text-on-primary' : 'hover:bg-white/5 text-on-surface-variant'}`}
                        >
                          Terrain
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <button 
                  onClick={handleLocateUser}
                  className="w-14 h-14 bg-surface-container-highest backdrop-blur-xl rounded-2xl flex items-center justify-center text-primary shadow-xl border border-white/10 active:scale-90 transition-all cursor-pointer group"
                  title={t('nearby')}
                >
                  <LocateFixed className="w-6 h-6 group-active:rotate-45 transition-transform" />
                </button>
                <button 
                  onClick={() => {
                    // Reset to default view
                    setUserLocation([9.0125, 38.7625]);
                  }}
                  className="w-14 h-14 bg-surface-container-highest backdrop-blur-xl rounded-2xl flex items-center justify-center text-on-surface-variant shadow-xl border border-white/10 active:scale-90 transition-all cursor-pointer"
                >
                  <Navigation className="w-6 h-6" />
                </button>
              </div>

              {/* Draggable Bottom Panel */}
              <div className="absolute bottom-0 w-full z-40 px-4">
                <div className="bg-surface-container-low rounded-t-xl pb-32 pt-3 shadow-[0_-12px_40px_rgba(0,0,0,0.6)] border-x border-t border-white/5">
                  <div className="w-12 h-1.5 bg-outline-variant/30 rounded-full mx-auto mb-6"></div>
                  <div className="px-6 flex justify-between items-end mb-6">
                    <div>
                      <h2 className="font-headline text-xl font-bold tracking-tight text-on-surface">{t('nearby')}</h2>
                      <p className="text-on-surface-variant text-sm font-medium amharic-text">{t('searchChargers')}</p>
                    </div>
                    <span className="text-primary text-xs font-semibold tracking-wider uppercase bg-primary/10 px-3 py-1 rounded-full">3 {t('active')}</span>
                  </div>
                  <div className="px-6 space-y-4 max-h-80 overflow-y-auto pb-4 custom-scrollbar">
                    {filteredChargers.length > 0 ? (
                      filteredChargers.map(charger => (
                        <div 
                          key={charger.id}
                          onClick={() => handleChargerClick(charger)}
                          className={`bg-surface-container p-4 rounded-lg flex items-center gap-4 border border-white/5 active:bg-surface-bright transition-colors cursor-pointer ${charger.status === 'OFFLINE' ? 'opacity-50' : ''}`}
                        >
                          <div className={`w-16 h-16 rounded-lg bg-surface-variant flex flex-col items-center justify-center border ${charger.status === 'AVAILABLE' ? 'text-primary border-primary/20' : charger.status === 'OCCUPIED' ? 'text-error border-error/20' : 'text-outline border-outline/20'}`}>
                            <span className="font-headline font-bold text-lg">{charger.power}</span>
                            <span className="text-[9px] font-bold">kW</span>
                          </div>
                          <div className="flex-1">
                            <div className="flex justify-between items-start">
                              <h3 className="font-bold text-on-surface font-body">{language === 'am' ? charger.nameAm : charger.name}</h3>
                              <span className={`text-xs font-bold ${charger.status === 'AVAILABLE' ? 'text-primary' : charger.status === 'OCCUPIED' ? 'text-error' : 'text-outline'}`}>
                                {charger.status === 'AVAILABLE' ? t('available') : charger.status === 'OCCUPIED' ? t('occupied') : t('offline')}
                              </span>
                            </div>
                            <p className="text-xs text-on-surface-variant mt-1 flex items-center gap-1">
                              <Navigation className="w-3 h-3" /> {charger.distance} • {charger.time}
                            </p>
                            <div className="flex justify-between items-center mt-3">
                              <div className="flex gap-2">
                                {charger.connectors.map(conn => (
                                  <span key={conn.type} className="bg-surface-container-highest px-2 py-0.5 rounded text-[10px] text-on-surface-variant border border-white/5">{conn.type}</span>
                                ))}
                              </div>
                              <div className="flex gap-2">
                                <button 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleChargerClick(charger);
                                  }}
                                  className="bg-surface-container-highest text-on-surface text-[10px] font-bold px-3 py-1.5 rounded-full active:scale-95 transition-all"
                                >
                                  {t('viewDetails')}
                                </button>
                                <button 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleNavigate(charger);
                                  }}
                                  className="bg-primary/10 text-primary p-2 rounded-full active:scale-90 transition-transform"
                                  title={t('navigate')}
                                >
                                  <Navigation className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="py-12 text-center">
                        <Search className="w-12 h-12 text-on-surface-variant/20 mx-auto mb-4" />
                        <p className="text-on-surface-variant text-sm italic">{t('noResultsFound') || 'No chargers found matching your criteria.'}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </main>
          </motion.div>
        ) : view === 'charger-details' && selectedCharger ? (
          <motion.div
            key="details"
            initial={{ opacity: 0, y: '100%' }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="flex-1 flex flex-col h-screen overflow-y-auto bg-surface z-[100]"
          >
            <header className="sticky top-0 z-50 bg-surface/80 backdrop-blur-xl px-6 py-4 flex items-center justify-between border-b border-white/5">
              <button 
                onClick={() => setView('map')}
                className="p-2 rounded-full hover:bg-white/10"
              >
                <ArrowRight className="rotate-180 w-6 h-6" />
              </button>
              <h2 className="font-headline font-bold">{t('stationDetails')}</h2>
              <button 
                onClick={() => toggleFavorite(selectedCharger.id)}
                className={`p-2 rounded-full ${favorites.includes(selectedCharger.id) ? 'text-primary' : 'text-on-surface-variant'}`}
              >
                <Bookmark className={`w-6 h-6 ${favorites.includes(selectedCharger.id) ? 'fill-current' : ''}`} />
              </button>
            </header>

            <main className="flex-1 pb-32">
              <div className="h-64 bg-surface-container-highest relative">
                <img 
                  src="https://lh3.googleusercontent.com/aida-public/AB6AXuDaTBgAOYed5glOR3klQJvoeJwh-olbNC72WU-Sb7Bcx4Axdvjxo-QCQpdHNOJXfsS7Qiy4IdDovM7Tzrw_6KFZoyb9IVgKWNX5-yPVbICb54_kfRSwcgnVWH8hBXv0XhSdcRgPJdv_Lm-n98ULIhF2zlZVry0DEL53SX7eHnT_Bh7MF4af7ei1dkG__F9F8t6xgKCWQCZ44_zZOZ_tV2OpLxUHJyWceKzeSNb7aJJQ2JST4wxLFuS4ZNfd4bqaKitnsrxRBXWUM0th" 
                  className="w-full h-full object-cover opacity-60"
                  alt="Station Map"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-surface to-transparent"></div>
              </div>

              <div className="px-6 -mt-12 relative z-10">
                <div className="bg-surface-container p-6 rounded-2xl border border-white/5 shadow-2xl">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h1 className="text-2xl font-headline font-black italic">{selectedCharger.name}</h1>
                      <p className="text-on-surface-variant amharic-text">{selectedCharger.nameAm}</p>
                    </div>
                    <div className="bg-primary/10 px-3 py-1 rounded-full">
                      <span className="text-primary text-xs font-bold">{selectedCharger.distance}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 mb-6">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-primary"></div>
                      <span className="text-sm font-semibold">{language === 'am' ? selectedCharger.slotsAm : selectedCharger.slots}</span>
                    </div>
                    <div className="w-px h-4 bg-outline-variant"></div>
                    <span className="text-sm text-on-surface-variant">{selectedCharger.power}kW {t('maxPower')}</span>
                  </div>

                    <div className="grid grid-cols-2 gap-4">
                      <button 
                        onClick={handleNavigate}
                        className="flex-1 bg-primary text-on-primary h-14 rounded-xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-all"
                      >
                        <Navigation className="w-5 h-5" /> {t('navigate')}
                      </button>
                      <button 
                        onClick={handleBookCharger}
                        className="flex-1 bg-surface-container-highest h-14 rounded-xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-all"
                      >
                        <Bolt className="w-5 h-5" /> {t('bookCharger')}
                      </button>
                    </div>
                </div>

                <div className="mt-8 space-y-6">
                  <section>
                    <h3 className="text-sm font-bold text-on-surface-variant uppercase tracking-wider mb-4">{t('connectors')}</h3>
                    <div className="space-y-3">
                      {selectedCharger.connectors.map(conn => (
                        <div key={conn.type} className="bg-surface-container p-4 rounded-xl flex items-center justify-between border border-white/5">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-lg bg-surface-variant flex items-center justify-center text-primary">
                              <Zap className="w-6 h-6" />
                            </div>
                            <div>
                              <p className="font-bold">{conn.type}</p>
                              <p className="text-xs text-on-surface-variant">{selectedCharger.power}kW • DC {t('fast')}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${
                              conn.status === 'available' ? 'bg-primary' : 
                              conn.status === 'busy' ? 'bg-warning' : 'bg-error'
                            }`}></div>
                            <span className={`text-xs font-bold uppercase ${
                              conn.status === 'available' ? 'text-primary' : 
                              conn.status === 'busy' ? 'text-warning' : 'text-error'
                            }`}>
                              {conn.status === 'available' ? t('available') : conn.status === 'busy' ? t('busy') : t('offline')}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h3 className="text-sm font-bold text-on-surface-variant uppercase tracking-wider mb-4">{t('price')}</h3>
                    <div className="bg-surface-container p-4 rounded-xl border border-white/5">
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-bold text-lg">{language === 'am' ? selectedCharger.priceAm : selectedCharger.price}</p>
                          <p className="text-xs text-on-surface-variant amharic-text">{selectedCharger.priceAm}</p>
                        </div>
                        <Bolt className="text-primary w-8 h-8 opacity-20" />
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </main>
          </motion.div>
        ) : view === 'search-filters' ? (
          <motion.div
            key="filters"
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="flex-1 flex flex-col h-screen bg-surface z-[100]"
          >
            <header className="px-6 py-6 flex items-center justify-between">
              <button 
                onClick={() => setView('map')}
                className="p-2 rounded-full bg-surface-container"
              >
                <ArrowRight className="rotate-180 w-6 h-6" />
              </button>
              <h2 className="font-headline font-bold text-xl">{t('filters')}</h2>
              <button 
                onClick={() => {
                  setAvailableNowOnly(false);
                  setSelectedChargerTypes([]);
                  setDistanceFilter(50);
                  setVehicleTypeFilter('All');
                }}
                className="text-primary font-bold text-sm"
              >
                {t('reset')}
              </button>
            </header>

            <main className="flex-1 px-6 space-y-8 overflow-y-auto pb-32">
              <section>
                <h3 className="text-sm font-bold text-on-surface-variant uppercase tracking-wider mb-4">{t('status')}</h3>
                <div 
                  onClick={() => setAvailableNowOnly(!availableNowOnly)}
                  className="flex items-center justify-between bg-surface-container p-4 rounded-xl cursor-pointer"
                >
                  <span className="font-medium">{t('availableNow')}</span>
                  <div className={`w-12 h-6 rounded-full relative p-1 transition-colors ${availableNowOnly ? 'bg-primary' : 'bg-surface-container-highest'}`}>
                    <motion.div 
                      animate={{ x: availableNowOnly ? 24 : 0 }}
                      className="w-4 h-4 bg-on-primary rounded-full"
                    ></motion.div>
                  </div>
                </div>
              </section>

              <section>
                <h3 className="text-sm font-bold text-on-surface-variant uppercase tracking-wider mb-4">{t('vehicleType')}</h3>
                <div className="grid grid-cols-3 gap-2">
                  {(['Electric', 'Hybrid', 'Gasoline'] as const).map(type => (
                    <button 
                      key={type}
                      onClick={() => setVehicleTypeFilter(type)}
                      className={`h-12 rounded-xl border font-medium transition-all text-xs ${vehicleTypeFilter === type ? 'bg-primary/10 border-primary text-primary' : 'border-white/10 text-on-surface-variant'}`}
                    >
                      {t(type.toLowerCase() as any)}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-sm font-bold text-on-surface-variant uppercase tracking-wider mb-4">{t('chargerType')}</h3>
                <div className="grid grid-cols-2 gap-3">
                  {['Type 1', 'Type 2', 'CCS', 'CHAdeMO'].map(type => {
                    const isSelected = selectedChargerTypes.includes(type);
                    return (
                      <button 
                        key={type}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedChargerTypes(prev => prev.filter(t => t !== type));
                          } else {
                            setSelectedChargerTypes(prev => [...prev, type]);
                          }
                        }}
                        className={`h-12 rounded-xl border font-medium transition-all ${isSelected ? 'bg-primary/10 border-primary text-primary' : 'border-white/10 text-on-surface-variant'}`}
                      >
                        {type}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-on-surface-variant uppercase tracking-wider">{t('distance')}</h3>
                  <span className="text-primary font-bold">{distanceFilter} {t('km')}</span>
                </div>
                <input 
                  type="range" 
                  min="1"
                  max="50"
                  value={distanceFilter}
                  onChange={(e) => setDistanceFilter(parseInt(e.target.value))}
                  className="w-full h-2 bg-surface-container rounded-lg appearance-none cursor-pointer accent-primary" 
                />
                <div className="flex justify-between mt-2 text-xs text-on-surface-variant">
                  <span>1 {t('km')}</span>
                  <span>50 {t('km')}</span>
                </div>
              </section>
            </main>

            <footer className="p-6 bg-surface/80 backdrop-blur-xl border-t border-white/5">
              <button 
                onClick={() => setView('map')}
                className="w-full bg-primary text-on-primary h-14 rounded-xl font-bold active:scale-95 transition-all"
              >
                {t('applyFilters')}
              </button>
            </footer>
          </motion.div>
        ) : view === 'saved' ? (
          <motion.div
            key="saved"
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="flex-1 flex flex-col h-screen bg-surface z-[100]"
          >
            <header className="px-6 pt-12 pb-6">
              <h1 className="text-3xl font-headline font-black italic">{t('savedLocations')}</h1>
              <p className="text-on-surface-variant amharic-text">{t('saved')}</p>
            </header>

            <main className="flex-1 px-6 space-y-4 overflow-y-auto pb-32">
              {favorites.length > 0 ? (
                chargers.filter(c => favorites.includes(c.id)).map(charger => (
                  <div 
                    key={charger.id}
                    onClick={() => handleChargerClick(charger)}
                    className="bg-surface-container p-4 rounded-xl border border-white/5 flex items-center gap-4"
                  >
                    <div className="w-16 h-16 rounded-lg bg-surface-variant flex flex-col items-center justify-center text-primary">
                      <span className="font-headline font-bold text-lg">{charger.power}</span>
                      <span className="text-[9px] font-bold">kW</span>
                    </div>
                    <div className="flex-1">
                      <h3 className="font-bold">{language === 'am' ? charger.nameAm : charger.name}</h3>
                      <p className="text-xs text-on-surface-variant">{charger.distance} • {language === 'am' ? charger.slotsAm : charger.slots}</p>
                      <div className="flex gap-2 mt-2">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNavigate(charger);
                          }}
                          className="bg-primary/10 text-primary text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-1 active:scale-95 transition-all"
                        >
                          <Navigation className="w-3 h-3" /> {t('navigate').toUpperCase()}
                        </button>
                      </div>
                    </div>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(charger.id);
                      }}
                      className="text-primary"
                    >
                      <Bookmark className="w-5 h-5 fill-current" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <Bookmark className="w-16 h-16 text-on-surface-variant/20 mb-4" />
                  <p className="text-on-surface-variant">{t('noSavedLocations')}</p>
                </div>
              )}
            </main>
          </motion.div>
        ) : view === 'booked' && activeBooking ? (
          <motion.div
            key="booked"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className="flex-1 flex flex-col h-screen bg-surface p-8"
          >
            <div className="flex-1 flex flex-col items-center justify-center gap-12">
              <div className="relative w-64 h-64">
                <svg className="w-full h-full transform -rotate-90">
                  <circle
                    cx="128"
                    cy="128"
                    r="120"
                    stroke="currentColor"
                    strokeWidth="8"
                    fill="transparent"
                    className="text-surface-container-highest"
                  />
                  <motion.circle
                    cx="128"
                    cy="128"
                    r="120"
                    stroke="currentColor"
                    strokeWidth="8"
                    fill="transparent"
                    strokeDasharray="753.98"
                    initial={{ strokeDashoffset: 753.98 }}
                    animate={{ strokeDashoffset: 753.98 - (753.98 * (activeBooking.duration / (30 * 60))) }}
                    className="text-primary"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-6xl font-headline font-black italic">
                    {Math.floor(activeBooking.duration / 60)}:{(activeBooking.duration % 60).toString().padStart(2, '0')}
                  </span>
                  <span className="text-on-surface-variant font-bold uppercase tracking-widest text-xs">{t('booked')}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-8 w-full max-w-sm">
                <div className="text-center bg-surface-container p-6 rounded-2xl border border-white/5">
                  <p className="text-on-surface-variant text-xs font-bold uppercase tracking-widest mb-1">{t('bookingFee')}</p>
                  <p className="text-3xl font-headline font-bold">{activeBooking.bookingFee} <span className="text-sm">ETB</span></p>
                </div>
              </div>

              <div className="w-full max-w-sm text-center space-y-4">
                <p className="text-on-surface-variant text-sm">
                  {t('bookingExpiryNote') || "Your reservation will expire when the timer reaches zero."}
                </p>
                <div className="flex items-center justify-center gap-2 text-primary font-bold">
                  <Navigation className="w-4 h-4" />
                  <button onClick={handleNavigate} className="underline">{t('navigate')}</button>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4 mb-8">
              <button 
                onClick={() => setView('payment')}
                className="w-full bg-primary text-on-primary h-16 rounded-2xl font-headline font-bold text-lg shadow-lg active:scale-95 transition-all"
              >
                {t('confirmPay')}
              </button>
              <button 
                onClick={handleCancelBooking}
                className="w-full bg-surface-container-highest text-on-surface h-16 rounded-2xl font-headline font-bold text-lg active:scale-95 transition-all"
              >
                {t('cancelBooking')}
              </button>
            </div>
          </motion.div>
        ) : view === 'payment' && activeBooking ? (
          <motion.div
            key="payment"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="flex-1 flex flex-col h-screen bg-surface"
          >
            <header className="px-6 py-6 flex items-center gap-4">
              <button 
                onClick={() => setView('booked')}
                className="p-2 rounded-full bg-surface-container"
              >
                <ArrowRight className="rotate-180 w-6 h-6" />
              </button>
              <h2 className="font-headline font-bold text-xl">{t('payment')}</h2>
            </header>

            <main className="flex-1 px-6 space-y-8 overflow-y-auto pb-32">
              <div className="bg-kinetic-gradient p-8 rounded-3xl text-on-primary shadow-2xl shadow-primary/20">
                <p className="text-sm font-bold opacity-80 uppercase tracking-widest mb-2">{t('totalAmount')}</p>
                <h1 className="text-5xl font-headline font-black italic">{activeBooking.bookingFee.toFixed(2)} <span className="text-2xl">ETB</span></h1>
                <div className="mt-8 flex justify-between items-end">
                  <div>
                    <p className="text-xs opacity-80">{t('bookingFee')}</p>
                    <p className="text-xs opacity-80">{t('duration')}: {Math.floor(activeBooking.duration / 60)} {t('mins')}</p>
                  </div>
                  <Bolt className="w-12 h-12 opacity-40" />
                </div>
              </div>

              <section>
                <h3 className="text-sm font-bold text-on-surface-variant uppercase tracking-wider mb-4">{t('paymentMethod')}</h3>
                <div className="space-y-3">
                  {[
                    { name: 'Telebirr', icon: '📱' },
                    { name: 'CBE Birr', icon: '🏦' },
                    { name: 'Visa / Mastercard', icon: '💳' }
                  ].map((method, idx) => (
                    <div 
                      key={method.name}
                      className={`p-4 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${idx === 0 ? 'bg-primary/5 border-primary' : 'bg-surface-container border-white/5'}`}
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-2xl">{method.icon}</span>
                        <span className="font-bold">{method.name}</span>
                      </div>
                      {idx === 0 && <div className="w-5 h-5 bg-primary rounded-full flex items-center justify-center"><Bolt className="w-3 h-3 text-on-primary fill-current" /></div>}
                    </div>
                  ))}
                </div>
              </section>
            </main>

            <footer className="p-6 bg-surface/80 backdrop-blur-xl border-t border-white/5">
              <button 
                onClick={handlePayment}
                disabled={isProcessingPayment}
                className="w-full bg-primary text-on-primary h-16 rounded-2xl font-headline font-bold text-lg shadow-lg active:scale-95 transition-all flex items-center justify-center gap-3"
              >
                {isProcessingPayment ? (
                  <>
                    <div className="w-5 h-5 border-2 border-on-primary border-t-transparent rounded-full animate-spin"></div>
                    {t('processing')}...
                  </>
                ) : (
                  t('confirmPay')
                )}
              </button>
            </footer>
          </motion.div>
        ) : view === 'payment-success' ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col h-screen bg-surface items-center justify-center p-8 text-center"
          >
            <div className="w-24 h-24 bg-primary/20 rounded-full flex items-center justify-center mb-8">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', damping: 12 }}
              >
                <Bolt className="text-primary w-12 h-12 fill-current" />
              </motion.div>
            </div>
            <h1 className="text-4xl font-headline font-black italic mb-4">{t('paymentSuccess')}</h1>
            <p className="text-on-surface-variant mb-12">{t('paymentSuccessDesc')}</p>
            
            <div className="w-full bg-surface-container p-6 rounded-2xl border border-white/5 mb-12">
              <div className="flex justify-between items-center mb-2">
                <span className="text-on-surface-variant text-sm">{t('amountPaid')}</span>
                <span className="font-bold">{activeBooking?.bookingFee.toFixed(2)} ETB</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-on-surface-variant text-sm">{t('transactionId')}</span>
                <span className="font-mono text-xs">{activeBooking?.transactionId}</span>
              </div>
            </div>

            <button 
              onClick={() => {
                setActiveBooking(null);
                setView('map');
              }}
              className="w-full bg-surface-container-highest h-16 rounded-2xl font-headline font-bold text-lg active:scale-95 transition-all"
            >
              {t('backToMap')}
            </button>
          </motion.div>
        ) : view === 'profile' ? (
          <motion.div
            key="profile"
            initial={{ opacity: 0, x: '-100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '-100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="flex-1 flex flex-col h-screen bg-surface z-[100] overflow-y-auto"
          >
            {/* Header */}
            <header className="p-6 flex items-center justify-between sticky top-0 bg-surface/80 backdrop-blur-md z-10">
              <button 
                onClick={() => setView('map')}
                className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center active:scale-90 transition-transform"
              >
                <ArrowRight className="w-5 h-5 rotate-180" />
              </button>
              <h1 className="text-lg font-headline font-bold">{t('profile')}</h1>
              <div className="w-10" />
            </header>

            <div className="px-6 pb-24">
              {/* User Info */}
              <div className="flex flex-col items-center gap-4 mb-8">
                <div className="relative">
                  <div className="w-24 h-24 rounded-full bg-surface-container-highest flex items-center justify-center border-2 border-primary/20 overflow-hidden">
                    {user?.photoURL ? (
                      <img src={user.photoURL} alt={user.displayName || 'User'} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <User className="w-12 h-12 text-primary" />
                    )}
                  </div>
                  <button className="absolute bottom-0 right-0 w-8 h-8 bg-primary rounded-full flex items-center justify-center text-on-primary shadow-lg active:scale-90 transition-transform">
                    <Settings className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-center">
                  <h2 className="text-2xl font-headline font-bold">{user?.displayName || 'EV Driver'}</h2>
                  <p className="text-on-surface-variant text-sm">{user?.phoneNumber || user?.email || 'No contact info'}</p>
                </div>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-3 gap-3 mb-8">
                <div className="bg-surface-container p-4 rounded-2xl border border-white/5 flex flex-col items-center text-center">
                  <span className="text-[10px] text-on-surface-variant uppercase tracking-wider font-bold mb-1">{t('hours')}</span>
                  <span className="text-lg font-headline font-bold text-primary">{totalHours.toFixed(1)}</span>
                  <span className="text-[10px] text-on-surface-variant">HRS</span>
                </div>
                <div className="bg-surface-container p-4 rounded-2xl border border-white/5 flex flex-col items-center text-center">
                  <span className="text-[10px] text-on-surface-variant uppercase tracking-wider font-bold mb-1">{t('amount')}</span>
                  <span className="text-lg font-headline font-bold text-primary">{totalSpent.toFixed(0)}</span>
                  <span className="text-[10px] text-on-surface-variant">ETB</span>
                </div>
                <div className="bg-surface-container p-4 rounded-2xl border border-white/5 flex flex-col items-center text-center">
                  <span className="text-[10px] text-on-surface-variant uppercase tracking-wider font-bold mb-1">{t('bookings')}</span>
                  <span className="text-lg font-headline font-bold text-primary">{totalBookingsCount}</span>
                  <span className="text-[10px] text-on-surface-variant">{t('total')}</span>
                </div>
              </div>

              {/* Menu Links */}
              <div className="space-y-2 mb-8">
                <button 
                  onClick={() => setToast(t('comingSoon'))}
                  className="w-full p-4 bg-surface-container rounded-2xl flex items-center justify-between border border-white/5 active:scale-[0.98] transition-all group"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <CreditCard className="w-5 h-5" />
                    </div>
                    <span className="font-bold">{t('paymentMethods')}</span>
                  </div>
                  <ArrowRight className="w-5 h-5 text-on-surface-variant group-hover:translate-x-1 transition-transform" />
                </button>

                <button 
                  onClick={() => setToast(t('comingSoon'))}
                  className="w-full p-4 bg-surface-container rounded-2xl flex items-center justify-between border border-white/5 active:scale-[0.98] transition-all group"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Settings className="w-5 h-5" />
                    </div>
                    <span className="font-bold">{t('settings')}</span>
                  </div>
                  <ArrowRight className="w-5 h-5 text-on-surface-variant group-hover:translate-x-1 transition-transform" />
                </button>

                <button 
                  onClick={() => setToast(t('comingSoon'))}
                  className="w-full p-4 bg-surface-container rounded-2xl flex items-center justify-between border border-white/5 active:scale-[0.98] transition-all group"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <HelpCircle className="w-5 h-5" />
                    </div>
                    <span className="font-bold">{t('help')}</span>
                  </div>
                  <ArrowRight className="w-5 h-5 text-on-surface-variant group-hover:translate-x-1 transition-transform" />
                </button>
              </div>

              {/* Recent Activity */}
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-headline font-bold text-lg">{t('recentActivity')}</h3>
                <button 
                  onClick={() => setShowHistory(!showHistory)}
                  className="text-primary text-sm font-bold active:scale-95 transition-transform"
                >
                  {showHistory ? t('hide') : t('viewAll')}
                </button>
              </div>

              <div className="space-y-3">
                {isFetchingHistory ? (
                  <div className="flex justify-center p-8">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  </div>
                ) : pastBookings.length === 0 ? (
                  <div className="p-8 text-center bg-surface-container rounded-2xl border border-dashed border-white/10">
                    <p className="text-on-surface-variant text-sm italic">{t('noHistory')}</p>
                  </div>
                ) : (
                  pastBookings.slice(0, showHistory ? undefined : 3).map((booking) => (
                    <div key={booking.id} className="bg-surface-container p-4 rounded-2xl border border-white/5 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                          <Bolt className="w-6 h-6" />
                        </div>
                        <div>
                          <h4 className="font-bold text-sm">{booking.chargerName}</h4>
                          <p className="text-[10px] text-on-surface-variant">
                            {booking.timestamp?.toDate().toLocaleDateString()} • {booking.timestamp?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-sm text-primary">{Math.floor(booking.duration / 60)} {t('mins')}</p>
                        <p className="text-[10px] text-on-surface-variant">{booking.bookingFee.toFixed(2)} ETB</p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Logout */}
              <button 
                onClick={handleSignOut}
                className="w-full mt-12 p-4 bg-error/10 text-error rounded-2xl flex items-center justify-center gap-3 font-bold active:scale-95 transition-transform"
              >
                <LogOut className="w-5 h-5" />
                {t('signOut')}
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* BottomNavBar */}
      {!isSubPage && view !== 'onboarding' && (
        <nav className="fixed bottom-0 w-full rounded-t-[24px] z-50 bg-[#131313] shadow-[0_-8px_24px_rgba(0,0,0,0.5)] flex justify-around items-center h-20 px-4 pb-safe border-t border-white/5">
          <button 
            onClick={() => setView('map')}
            aria-label={t('map')}
            className={`flex flex-col items-center justify-center transition-all active:scale-90 duration-300 cursor-pointer flex-1 h-full ${view === 'map' ? 'text-primary' : 'text-gray-500 hover:text-white'}`}
          >
            <div className={`p-1.5 rounded-full transition-colors ${view === 'map' ? 'bg-primary/10' : ''}`}>
              <MapPin className={`w-6 h-6 ${view === 'map' ? 'fill-current' : ''}`} />
            </div>
            <span className="font-body text-[10px] font-bold tracking-wide mt-1 uppercase">{t('map')}</span>
          </button>
          <button 
            onClick={() => setView('search-filters')}
            aria-label={t('search')}
            className={`flex flex-col items-center justify-center transition-all active:scale-90 duration-300 cursor-pointer flex-1 h-full ${view === 'search-filters' ? 'text-primary' : 'text-gray-500 hover:text-white'}`}
          >
            <div className={`p-1.5 rounded-full transition-colors ${view === 'search-filters' ? 'bg-primary/10' : ''}`}>
              <Search className="w-6 h-6" />
            </div>
            <span className="font-body text-[10px] font-bold tracking-wide mt-1 uppercase">{t('search')}</span>
          </button>
          <button 
            onClick={() => setView('saved')}
            aria-label={t('saved')}
            className={`flex flex-col items-center justify-center transition-all active:scale-90 duration-300 cursor-pointer flex-1 h-full ${view === 'saved' ? 'text-primary' : 'text-gray-500 hover:text-white'}`}
          >
            <div className={`p-1.5 rounded-full transition-colors ${view === 'saved' ? 'bg-primary/10' : ''}`}>
              <Bookmark className={`w-6 h-6 ${view === 'saved' ? 'fill-current' : ''}`} />
            </div>
            <span className="font-body text-[10px] font-bold tracking-wide mt-1 uppercase">{t('saved')}</span>
          </button>
          <button 
            onClick={() => setView('profile')}
            aria-label={t('profile')}
            className={`flex flex-col items-center justify-center transition-all active:scale-90 duration-300 cursor-pointer flex-1 h-full ${view === 'profile' ? 'text-primary' : 'text-gray-500 hover:text-white'}`}
          >
            <div className={`p-1.5 rounded-full transition-colors ${view === 'profile' ? 'bg-primary/10' : ''}`}>
              <User className="w-6 h-6" />
            </div>
            <span className="font-body text-[10px] font-bold tracking-wide mt-1 uppercase">{t('profile')}</span>
          </button>
        </nav>
      )}

      {/* Booking Confirmation Dialog */}
      <AnimatePresence>
        {showBookingConfirmation && selectedCharger && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowBookingConfirmation(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-sm bg-surface-container rounded-3xl border border-white/10 shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center text-primary mb-6">
                  <Bolt className="w-8 h-8" />
                </div>
                <h3 className="text-2xl font-headline font-bold mb-2">{t('confirmBooking')}</h3>
                <p className="text-on-surface-variant text-sm mb-8">{t('bookingSummary')}</p>

                <div className="space-y-4 mb-8">
                  <div className="flex justify-between items-center p-4 bg-surface-container-highest rounded-xl">
                    <span className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('location')}</span>
                    <span className="font-bold text-sm">{language === 'am' ? selectedCharger.nameAm : selectedCharger.name}</span>
                  </div>
                  <div className="flex justify-between items-center p-4 bg-surface-container-highest rounded-xl">
                    <span className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('duration')}</span>
                    <span className="font-bold text-sm">30 {t('mins')}</span>
                  </div>
                  <div className="flex justify-between items-center p-4 bg-primary/10 rounded-xl border border-primary/20">
                    <span className="text-xs font-bold uppercase tracking-widest text-primary">{t('bookingFee')}</span>
                    <span className="font-bold text-lg text-primary">50 ETB</span>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowBookingConfirmation(false)}
                    className="flex-1 h-14 rounded-xl font-bold bg-surface-container-highest active:scale-95 transition-all"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    onClick={confirmBooking}
                    className="flex-1 h-14 rounded-xl font-bold bg-primary text-on-primary shadow-lg shadow-primary/20 active:scale-95 transition-all"
                  >
                    {t('confirm')}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {view === 'admin' && <AdminView />}

      {/* Visual Accents (Glows) */}
      <div className="fixed top-[-10%] right-[-10%] w-[60%] h-[40%] bg-primary/10 blur-[120px] rounded-full z-0 pointer-events-none"></div>
      <div className="fixed bottom-[-5%] left-[-10%] w-[50%] h-[30%] bg-tertiary/10 blur-[100px] rounded-full z-0 pointer-events-none"></div>
      </div>
    </ErrorBoundary>
  );
}
