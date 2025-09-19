# 📄 Guía de Implementación: Procesamiento de Documentos PDF y DOCX

## 🚀 Paso a Paso Completo

### ✅ Paso 1: Instalación de Dependencias

Ejecutar en la terminal desde el directorio del proyecto:

```bash
cd C:\Users\david\TicketSupportV1\agente
npm install pdf-parse mammoth
```

**Opcional - Tipos TypeScript (recomendado):**
```bash
npm install --save-dev @types/pdf-parse
# Nota: @types/mammoth no existe, pero el código ya maneja esto
```

### ✅ Paso 2: Verificar Instalación

Después de instalar, reinicia el servidor y verifica que las librerías se carguen correctamente:

```bash
npm run dev
```

Deberías ver en la consola:
```
✅ pdf-parse cargado correctamente
✅ mammoth cargado correctamente
```

### ✅ Paso 3: Verificar Formatos Soportados

Consulta qué formatos están disponibles:

```bash
curl http://localhost:3000/ai/document/formats
```

**Respuesta esperada después de instalar:**
```json
{
  "supported_formats": {
    "txt": true,
    "md": true,
    "pdf": true,    // ✅ Ahora true
    "docx": true,   // ✅ Ahora true
    "csv": true,
    "json": true,
    "xml": true
  },
  "installation_instructions": {},
  "fully_supported": ["txt", "md", "pdf", "docx", "csv", "json", "xml"],
  "requires_installation": []
}
```

## 📋 Ejemplos de Uso

### 1️⃣ Extraer Texto de PDF

```bash
curl -X POST http://localhost:3000/ai/document \
  -H "Content-Type: application/json" \
  -H "x-api-key: TU_API_KEY" \
  -d '{
    "mode": "extract",
    "document_url": "https://ejemplo.com/documento.pdf",
    "max_length": 5000
  }'
```

**Respuesta:**
```json
{
  "mode": "extract",
  "document_url": "https://ejemplo.com/documento.pdf",
  "extracted_text": "Contenido completo del PDF...",
  "metadata": {
    "format": "pdf",
    "originalLength": 12543,
    "truncated": true,
    "pages": 5,
    "info": {
      "Title": "Mi Documento",
      "Author": "Usuario",
      "CreationDate": "..."
    },
    "size": 204800
  },
  "cost_usd": 0.001
}
```

### 2️⃣ Analizar Documento DOCX con IA

```bash
curl -X POST http://localhost:3000/ai/document \
  -H "Content-Type: application/json" \
  -H "x-api-key: TU_API_KEY" \
  -d '{
    "mode": "analyze",
    "document_url": "https://ejemplo.com/contrato.docx",
    "question": "¿Cuáles son las cláusulas más importantes de este contrato?",
    "language": "es"
  }'
```

**Respuesta:**
```json
{
  "mode": "analyze",
  "document_url": "https://ejemplo.com/contrato.docx",
  "question": "¿Cuáles son las cláusulas más importantes?",
  "extracted_text": "Contenido del DOCX...",
  "analysis": "Análisis detallado: Las cláusulas más importantes son...",
  "metadata": {
    "format": "docx",
    "originalLength": 8432,
    "truncated": false,
    "messages": [],
    "size": 156742
  },
  "model_used": "gpt-4.1-mini",
  "cost_usd": 0.024,
  "tokens_used": {"input": 2100, "output": 450}
}
```

## 🔧 Formatos Soportados Completamente

| Formato | Librería | Estado | Funcionalidades |
|---------|----------|--------|-----------------|
| **PDF** | pdf-parse | ✅ Completo | Texto, metadatos, número de páginas |
| **DOCX** | mammoth | ✅ Completo | Texto, mensajes de conversión |
| **TXT** | Nativo | ✅ Completo | Texto plano |
| **MD** | Nativo | ✅ Completo | Markdown como texto |
| **CSV** | Nativo | ✅ Completo | Datos estructurados |
| **JSON** | Nativo | ✅ Completo | Datos JSON |
| **XML** | Nativo | ✅ Completo | Datos XML |
| **HTML** | Nativo | ✅ Completo | HTML como texto |

## ⚠️ Solución de Problemas

### Error: "pdf-parse no está instalado"
```bash
npm install pdf-parse
```

### Error: "mammoth no está instalado"
```bash
npm install mammoth
```

### Error: "Cannot find module"
1. Verifica que estés en el directorio correcto
2. Ejecuta `npm install` para instalar todas las dependencias
3. Reinicia el servidor

### Archivos PDF corruptos o protegidos
- El endpoint retornará un error descriptivo
- Considera convertir el PDF a texto externamente

### Archivos DOCX muy grandes
- Usa el parámetro `max_length` para limitar la extracción
- Considera dividir documentos grandes

## 💡 Mejoras Futuras Posibles

1. **Soporte para más formatos:**
   - PPT/PPTX: `npm install officegen`
   - RTF: `npm install rtf-parser`
   - ODT: `npm install odt2txt`

2. **OCR para PDFs escaneados:**
   - `npm install tesseract.js`

3. **Cacheo de documentos extraídos**
4. **Límites de tamaño de archivo**
5. **Análisis de estructura de documentos**

## 🎉 ¡Listo!

Una vez instaladas las dependencias, tu sistema podrá:
- ✅ Extraer texto de PDFs completos
- ✅ Procesar documentos Word (DOCX)
- ✅ Analizar contenido con IA
- ✅ Manejar múltiples formatos de texto
- ✅ Proporcionar metadatos detallados
- ✅ Control completo de costos y logging

¡El sistema está completamente preparado para procesamiento profesional de documentos! 🚀
