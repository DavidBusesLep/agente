# 🔍 Guía de Debugging PDF - Logs Detallados

## 🎯 **Logs Implementados**

He agregado logging exhaustivo al parser PDF para diagnosticar exactamente qué está pasando con la extracción de texto.

### 📊 **Información que Verás en los Logs:**

#### **1. Información Básica del Archivo**
```
🔄 Procesando PDF con método nativo mejorado...
📊 Tamaño del archivo PDF: 123456 bytes
📄 Contenido decodificado: 45678 caracteres
🔍 Primeros 200 caracteres: %PDF-1.4...
```

#### **2. Análisis de Patrones PDF**
```
🎯 Encontrados 5 bloques BT/ET
📝 BT/ET bloque 1: "Tf 12 0 0 12 100 700 Tm (Hola mundo) Tj..."
🎯 Encontrados 15 textos en paréntesis válidos
📝 Texto en paréntesis 1: "Hola mundo"
📝 Texto en paréntesis 2: "Este es un documento"
🎯 Encontrados 8 comandos Tj
📝 Comando Tj 1: "Título del documento"
🎯 Encontrados 3 arrays de texto
```

#### **3. Procesamiento del Texto**
```
📊 Total de streams de texto encontrados: 25
📝 Texto combinado inicial: 1234 caracteres
🔍 Primeros 300 caracteres del texto extraído: "Hola mundo Este es un documento..."
🔍 Últimos 100 caracteres del texto extraído: "...fin del documento"
```

#### **4. Métodos de Fallback (si es necesario)**
```
⚠️ Texto insuficiente, intentando método de palabras sueltas...
🔍 Palabras encontradas: 150
🔍 Primeras 20 palabras: documento, texto, información, datos...
📝 Texto de palabras sueltas: 800 caracteres
```

#### **5. Resultado Final**
```
✅ PDF procesado exitosamente con método nativo
📤 Enviando texto final: 1234 caracteres
📤 Texto final completo: "[DOCUMENTO: archivo.pdf] Hola mundo Este es un documento..."
```

### 🔍 **Información del Flujo Completo:**

#### **En el Procesamiento de Conversación:**
```
📄 Procesando documento desde URL: https://ejemplo.com/doc.pdf
📄 Archivo descargado: doc.pdf, tamaño: 123456 bytes
📄 Texto extraído: 1234 caracteres
📄 Metadatos: {"format": "pdf", "method": "native_pdf_parsing"...}
📤 Texto final para IA: 1280 caracteres
📤 Contenido para IA: "[DOCUMENTO: doc.pdf] Hola mundo..."
```

## 🧪 **Cómo Interpretar los Logs:**

### ✅ **Extracción Exitosa:**
Si ves:
- `🎯 Encontrados X bloques BT/ET` (X > 0)
- `📝 Texto combinado inicial: Y caracteres` (Y > 50)
- `✅ PDF procesado exitosamente`
- `📤 Texto final completo: "contenido real"`

**→ El PDF se procesó correctamente**

### ⚠️ **Extracción Parcial:**
Si ves:
- `🎯 Encontrados 0 bloques BT/ET`
- `⚠️ Texto insuficiente, intentando método de palabras sueltas...`
- `⚠️ PDF procesado con método de fallback`

**→ El PDF se procesó con método básico**

### ❌ **Extracción Fallida:**
Si ves:
- `❌ No se pudo extraer texto del PDF con ningún método`
- `📊 Resumen: BT/ET: 0, Paréntesis: 0, Tj: 0, Arrays: 0`

**→ El PDF no tiene texto extraíble (posiblemente escaneado)**

## 🔧 **Próximos Pasos para Debugging:**

### **1. Reiniciar el Servidor**
```bash
npm run dev
```

### **2. Probar con el PDF Problemático**
Envía el mismo PDF que causó el problema y observa los logs.

### **3. Analizar los Logs**
Busca específicamente:
- ¿Cuántos patrones se encontraron?
- ¿Qué texto se extrajo exactamente?
- ¿Qué método se usó (nativo vs fallback)?

### **4. Casos Comunes:**

#### **PDF con Texto Normal:**
```
🎯 Encontrados 10+ bloques BT/ET
📝 Texto combinado inicial: 500+ caracteres
✅ PDF procesado exitosamente
```

#### **PDF Escaneado (Solo Imágenes):**
```
🎯 Encontrados 0 bloques BT/ET
🎯 Encontrados 0 textos en paréntesis válidos
❌ No se pudo extraer texto del PDF
```

#### **PDF Protegido/Encriptado:**
```
🔍 Primeros 200 caracteres: caracteres extraños/binarios
⚠️ Texto insuficiente, intentando método de fallback...
```

## 📋 **Checklist de Diagnóstico:**

- [ ] ¿El archivo se descarga correctamente? (tamaño > 0)
- [ ] ¿Se encuentran patrones PDF? (BT/ET, paréntesis, Tj)
- [ ] ¿El texto extraído tiene sentido?
- [ ] ¿La IA recibe el texto correctamente?

## 🎯 **Resultado Esperado:**

Con estos logs detallados, podremos identificar exactamente:
1. **Si el PDF se descarga bien**
2. **Qué patrones de texto se encuentran**
3. **Qué texto exacto se extrae**
4. **Qué recibe la IA para procesar**

¡Ahora prueba el mismo PDF y veremos exactamente qué está pasando! 🔍
