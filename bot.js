require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cities = require('./cities');

const regionsToSkip = ["Чернігівщина", "Сумщина", "Полтавщина", "Київщина", "Житомирщина", "Вінничина", "Кіровоградщина", "Харківщина", "Дніпропетровщина", "Одещина", "Миколаївщина", "Херсонщина"];

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccountKey.json')),
  databaseURL: 'https://ukraine-radar-default-rtdb.europe-west1.firebasedatabase.app'
});

const db = admin.database();
const bot = new TelegramBot(TOKEN, { polling: true });

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/ʼ|'/g, "'")
    .replace(/і/g, "i")
    .replace(/ї/g, "i")
    .replace(/є/g, "e")
    .replace(/ґ/g, "g");
}

// Get city coordinates from cities.js - FIXED VERSION
function getCityCoordinates(cityName) {
  const normalizedCityName = normalize(cityName);
  
  // First, check for exact match with city names in the database
  for (const city in cities) {
    // Check if it's just coordinates array
    if (Array.isArray(cities[city]) && cities[city].length === 2) {
      // Direct match with city name
      if (normalize(city) === normalizedCityName) {
        return cities[city]; // Return [lat, lng]
      }
    }
  }
  
  // If no exact match, check for partial match
  for (const city in cities) {
    if (normalize(city).includes(normalizedCityName) || 
        normalizedCityName.includes(normalize(city))) {
      // Skip if it's a region name
      const isRegion = regionsToSkip.some(r => 
        normalize(r).includes(normalize(city)) || 
        normalize(city).includes(normalize(r))
      );
      
      if (!isRegion) {
        return cities[city];
      }
    }
  }
  
  return null;
}

// Generate points within 1km of each other
function generateNearbyPoints(centerLat, centerLng, count) {
  const points = [];
  
  if (count === 1) {
    // For single UAV, place it at the city center
    points.push({ lat: centerLat, lng: centerLng });
    return points;
  }
  
  const maxRadius = 0.009; // ~1km maximum
  const minDistance = 0.001; // ~111m minimum
  
  for (let i = 0; i < count; i++) {
    let lat, lng;
    let attempts = 0;
    let valid = false;
    
    while (attempts < 50 && !valid) {
      // Generate random point within 1km radius
      const angle = Math.random() * 2 * Math.PI;
      const distance = Math.random() * maxRadius;
      lat = centerLat + (distance * Math.cos(angle)) / 111.32;
      lng = centerLng + (distance * Math.sin(angle)) / (111.32 * Math.cos(centerLat * Math.PI / 180));
      
      // Check if point is within 1km of center
      const distFromCenter = Math.sqrt(
        Math.pow((lat - centerLat) * 111.32, 2) + 
        Math.pow((lng - centerLng) * 111.32 * Math.cos(centerLat * Math.PI / 180), 2)
      );
      
      if (distFromCenter > 1) { // More than 1km from center
        attempts++;
        continue;
      }
      
      // Check distance from other points
      valid = true;
      for (const point of points) {
        const dist = Math.sqrt(
          Math.pow((lat - point.lat) * 111.32, 2) + 
          Math.pow((lng - point.lng) * 111.32 * Math.cos(centerLat * Math.PI / 180), 2)
        );
        
        if (dist < 0.05) { // Less than 50m - too close
          valid = false;
          break;
        }
      }
      
      attempts++;
    }
    
    if (valid) {
      points.push({ lat, lng });
    } else {
      // Fallback: place at increasing distance from center
      const angle = (i * 2 * Math.PI) / count;
      const distance = 0.002 + (i * 0.001); // 200m to 2km
      lat = centerLat + (distance * Math.cos(angle)) / 111.32;
      lng = centerLng + (distance * Math.sin(angle)) / (111.32 * Math.cos(centerLat * Math.PI / 180));
      points.push({ lat, lng });
    }
  }
  
  return points;
}

// Improved city extraction with separate counts
function extractCityCountPairs(text) {
  console.log('🔍 Начинаем парсинг текста:', text);
  const lines = text.split('\n');
  const cityCounts = {};
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    console.log('📝 Обрабатываем строку:', trimmedLine);
    
    // Check if line contains region name and skip
    let isRegionLine = false;
    for (const region of regionsToSkip) {
      if (normalize(trimmedLine).includes(normalize(region))) {
        console.log(`⏭️ Пропущена строка с регионом: ${region}`);
        isRegionLine = true;
        break;
      }
    }
    if (isRegionLine) continue;
    
    // Clean the line
    const cleanLine = trimmedLine
      .replace(/\(https?:\/\/[^)]+\)/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[➡️▶️⚡️❤️]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (!cleanLine) continue;
    
    console.log('🧹 Очищенная строка:', cleanLine);
    
    // SIMPLIFIED pattern for "X БпЛА на/в/по Город"
    // Match patterns like: "2 БпЛА на Десну", "БпЛА на Київ", "1 UAV to Sumy"
    const pattern = /(\d+)?\s*(?:бпла|uav|шахед|дрон|ракета|rocket|missile)\s+(?:на|по|в|to)\s+([а-яіїє'a-z\s-]+)/i;
    const match = cleanLine.match(pattern);
    
    if (match) {
      let count = match[1] ? parseInt(match[1]) : 1;
      let cityName = match[2].trim();
      
      console.log(`🔢 Найдено: ${count} БпЛА на "${cityName}"`);
      
      // Skip if it's a region name (check for region suffix)
      const hasRegionSuffix = cityName.endsWith('щина') || cityName.endsWith('ина');
      if (hasRegionSuffix) {
        console.log(`⏭️ Пропущено (название области): "${cityName}"`);
        continue;
      }
      
      // Skip specific region names
      let isRegion = false;
      for (const region of regionsToSkip) {
        if (normalize(cityName) === normalize(region)) {
          console.log(`⏭️ Пропущено (регион): "${cityName}"`);
          isRegion = true;
          break;
        }
      }
      if (isRegion) continue;
      
      // Find city coordinates
      const cityCoords = getCityCoordinates(cityName);
      if (cityCoords && cityCoords[0] && cityCoords[1]) {
        const cityKey = `${cityCoords[0]},${cityCoords[1]}`;
        
        // Add to counts - if city already exists, add to its count
        if (cityCounts[cityKey]) {
          cityCounts[cityKey].count += count;
        } else {
          cityCounts[cityKey] = {
            name: cityName,
            coords: cityCoords,
            count: count
          };
        }
        
        console.log(`✅ Найден город: "${cityName}" с количеством ${cityCounts[cityKey].count}`);
      } else {
        console.log(`⚠️ Город не найден: "${cityName}"`);
      }
    }
  }
  
  console.log('📊 Итоговые найденные города:', Object.values(cityCounts).map(c => `${c.name}: ${c.count}`));
  return cityCounts;
}

console.log('🤖 Telegram bot started');

// Handler for channel posts
bot.on('channel_post', async msg => {
  try {
    console.log('\n📩 Новое сообщение в канале:', msg.text);
    console.log('🆔 CHAT ID:', msg.chat.id);

    if (!msg.text) return;

    const text = normalize(msg.text);

    if (!text.match(/бпла|shahed|дрон|шахед|rocket|ракета|uav/i)) {
      console.log('⛔ Не про шахеды/ракеты');
      return;
    }

    console.log('✅ Сообщение про шахеды/ракеты');

    // Determine type
    const isRocket = text.match(/ракета|rocket|missile/i);
    const type = isRocket ? 'rocket' : 'shahed';

    // DELETE ONLY OLD OBJECTS OF THIS TYPE
    const snapshot = await db.ref('shahads').once('value');
    const existingData = snapshot.val() || {};
    
    for (const id in existingData) {
      if (existingData[id].type === type) {
        await db.ref('shahads/' + id).remove();
      }
    }
    console.log(`🗑 Старые ${type === 'rocket' ? 'ракеты' : 'шахеды'} удалены`);

    // Extract city-count pairs
    const cityCounts = extractCityCountPairs(msg.text);
    
    console.log('📊 Найдены города и количества:', Object.entries(cityCounts).map(([k, v]) => `${v.name}: ${v.count}`));
    
    // Process each city independently
    for (const [cityKey, cityData] of Object.entries(cityCounts)) {
      const cityName = cityData.name;
      const [centerLat, centerLng] = cityData.coords;
      const count = cityData.count;
      
      console.log(`\n📍 Обработка города: ${cityName}, количество: ${count}`);
      console.log(`📍 Координаты ${cityName}: ${centerLat}, ${centerLng}`);
      
      // Generate positions for UAVs near this city
      const positions = generateNearbyPoints(centerLat, centerLng, count);
      
      for (let i = 0; i < positions.length; i++) {
        const { lat, lng } = positions[i];
        const id = crypto.randomUUID();
        
        // Static UAV - single point path (no movement)
        const path = [{ lat, lng }];
        
        // Speed 0 for static objects
        const speed = 0;
        
        await db.ref('shahads/' + id).set({
          type: type,
          path: path,
          speed: speed,
          startTime: Date.now(),
          city: cityName,
          static: true, // Mark as static
          position: { lat, lng }
        });
        
        console.log(`✈️ Создан статический ${type} #${i+1} для ${cityName} в точке ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
      }
      
      console.log(`🚀 Добавлено ${count} ${type === 'rocket' ? 'ракет(ы)' : 'шахед(ов)'} в районе ${cityName}`);
    }
    
  } catch (err) {
    console.error('❌ ОШИБКА:', err);
  }
});

// Handler for private messages
bot.on('message', async msg => {
  try {
    // Skip channel posts (already handled)
    if (msg.chat.type === 'channel') return;
    
    console.log('\n📩 Новое личное сообщение:', msg.text);
    console.log('🆔 CHAT ID:', msg.chat.id);

    if (!msg.text) return;

    const text = normalize(msg.text);

    if (!text.match(/бпла|shahed|дрон|шахед|rocket|ракета|uav/i)) {
      console.log('⛔ Не про шахеды/ракеты');
      return;
    }

    console.log('✅ Сообщение про шахеды/ракеты');

    // Determine type
    const isRocket = text.match(/ракета|rocket|missile/i);
    const type = isRocket ? 'rocket' : 'shahed';

    // Extract city-count pairs
    const cityCounts = extractCityCountPairs(msg.text);
    
    console.log('📊 Найдены города и количества:', Object.entries(cityCounts).map(([k, v]) => `${v.name}: ${v.count}`));
    
    // Process each city independently
    for (const [cityKey, cityData] of Object.entries(cityCounts)) {
      const cityName = cityData.name;
      const [centerLat, centerLng] = cityData.coords;
      const count = cityData.count;
      
      console.log(`\n📍 Обработка города: ${cityName}, количество: ${count}`);
      console.log(`📍 Координаты ${cityName}: ${centerLat}, ${centerLng}`);
      
      // Generate positions for UAVs near this city
      const positions = generateNearbyPoints(centerLat, centerLng, count);
      
      for (let i = 0; i < positions.length; i++) {
        const { lat, lng } = positions[i];
        const id = crypto.randomUUID();
        
        // Static UAV - single point path (no movement)
        const path = [{ lat, lng }];
        
        // Speed 0 for static objects
        const speed = 0;
        
        await db.ref('shahads/' + id).set({
          type: type,
          path: path,
          speed: speed,
          startTime: Date.now(),
          city: cityName,
          static: true, // Mark as static
          position: { lat, lng }
        });
        
        console.log(`✈️ Создан статический ${type} #${i+1} для ${cityName} в точке ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
      }
      
      console.log(`🚀 Добавлено ${count} ${type === 'rocket' ? 'ракет(ы)' : 'шахед(ов)'} в районе ${cityName}`);
    }
    
  } catch (err) {
    console.error('❌ ОШИБКА:', err);
  }
});