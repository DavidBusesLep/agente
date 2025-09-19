# 📄 Integración de Documentos en `/ai/answer`

## 🚀 Nueva Funcionalidad

Ahora puedes enviar documentos directamente en la conversación junto con texto e imágenes. Los documentos se procesan automáticamente y su contenido se incluye en el contexto de la IA.

## 📝 Ejemplos de Uso

### 1️⃣ **Análisis Simple de Documento**

```json
{
  "conversation": [
    {
      "role": "user",
      "content": [
        {
          "type": "text", 
          "text": "Analiza este contrato y dime qué cláusulas son más riesgosas"
        },
        {
          "type": "document_url",
          "document_url": {
            "url": "https://ejemplo.com/contrato.pdf"
          }
        }
      ]
    }
  ]
}
```

### 2️⃣ **Comparación de Múltiples Documentos**

```json
{
  "conversation": [
    {
      "role": "user",
      "content": [
        {
          "type": "text", 
          "text": "Compara estos dos contratos y dime las diferencias principales:"
        },
        {
          "type": "document_url",
          "document_url": {
            "url": "https://ejemplo.com/contrato_v1.pdf",
            "max_length": 8000
          }
        },
        {
          "type": "document_url",
          "document_url": {
            "url": "https://ejemplo.com/contrato_v2.pdf", 
            "max_length": 8000
          }
        }
      ]
    }
  ]
}
```

### 3️⃣ **Documento + Imagen + Texto**

```json
{
  "conversation": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Basándote en este documento técnico y esta captura de pantalla, explica cómo configurar el sistema:"
        },
        {
          "type": "document_url",
          "document_url": {
            "url": "https://ejemplo.com/manual.pdf"
          }
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://ejemplo.com/screenshot.png"
          }
        }
      ]
    }
  ]
}
```

### 4️⃣ **Conversación Continua con Documentos**

```json
{
  "conversation": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Lee este informe financiero"
        },
        {
          "type": "document_url",
          "document_url": {
            "url": "https://ejemplo.com/informe_q3.pdf"
          }
        }
      ]
    },
    {
      "role": "assistant",
      "content": "He analizado el informe financiero del Q3. Los principales puntos son..."
    },
    {
      "role": "user", 
      "content": "¿Cuáles son los riesgos identificados en el documento?"
    }
  ]
}
```

### 5️⃣ **Configuración Avanzada de Extracción**

```json
{
  "conversation": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Extrae solo los puntos clave de este documento largo"
        },
        {
          "type": "document_url",
          "document_url": {
            "url": "https://ejemplo.com/documento_largo.pdf",
            "max_length": 5000,
            "extract_mode": "auto"
          }
        }
      ]
    }
  ]
}
```

## 📊 Respuesta del Sistema

### **Ejemplo de Respuesta Exitosa:**

```json
{
  "answer": {
    "role": "assistant",
    "content": "He analizado el contrato y identificado las siguientes cláusulas riesgosas:\n\n1. Cláusula 5.2: Limitación de responsabilidad muy amplia...\n2. Cláusula 8.1: Terminación unilateral sin aviso...",
    "context_tools": []
  },
  "model_used": "gpt-4.1-mini",
  "has_images": false,
  "has_documents": true,
  "processed_content": {
    "images": false,
    "documents": true
  }
}
```

## ⚙️ Parámetros de Configuración

### **document_url object:**

```json
{
  "url": "https://ejemplo.com/documento.pdf",      // Requerido
  "max_length": 10000,                             // Opcional, default: 10000
  "extract_mode": "auto"                           // Opcional: "auto" | "text_only"
}
```

- **`url`**: URL del documento a procesar
- **`max_length`**: Máximo número de caracteres a extraer (1-50000)
- **`extract_mode`**: 
  - `"auto"`: Extrae texto + metadatos cuando sea posible
  - `"text_only"`: Solo extrae texto plano

## 🔧 Formatos Soportados

| Formato | Soporte | Notas |
|---------|---------|-------|
| **PDF** | ✅ Completo | Requiere `npm install pdf-parse` |
| **DOCX** | ✅ Completo | Requiere `npm install mammoth` |
| **TXT** | ✅ Nativo | Texto plano |
| **MD** | ✅ Nativo | Markdown |
| **CSV** | ✅ Nativo | Datos tabulares |
| **JSON** | ✅ Nativo | Datos estructurados |
| **XML** | ✅ Nativo | Datos XML |
| **HTML** | ✅ Nativo | Contenido web |

## 💡 Casos de Uso Comunes

### **Análisis Legal:**
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "¿Este contrato cumple con la normativa GDPR?"},
    {"type": "document_url", "document_url": {"url": "https://ejemplo.com/contrato.pdf"}}
  ]
}
```

### **Revisión Técnica:**
```json
{
  "role": "user", 
  "content": [
    {"type": "text", "text": "Revisa esta especificación técnica y sugiere mejoras"},
    {"type": "document_url", "document_url": {"url": "https://ejemplo.com/specs.docx"}}
  ]
}
```

### **Análisis Financiero:**
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Calcula los KPIs principales de este informe"},
    {"type": "document_url", "document_url": {"url": "https://ejemplo.com/report.pdf"}}
  ]
}
```

### **Resumen Ejecutivo:**
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Crea un resumen ejecutivo de 200 palabras"},
    {"type": "document_url", "document_url": {"url": "https://ejemplo.com/proposal.pdf", "max_length": 15000}}
  ]
}
```

## ⚡ Ventajas de la Integración

1. **🔄 Flujo Natural**: Los documentos se procesan automáticamente como parte de la conversación
2. **💰 Eficiencia de Costos**: Un solo endpoint para texto + documentos + imágenes
3. **🧠 Contexto Inteligente**: La IA puede referenciar el documento en conversaciones futuras
4. **🎯 Selección Automática**: El modelo se selecciona automáticamente según el contenido
5. **📊 Transparencia**: Respuesta incluye información sobre qué se procesó

## ⚠️ Consideraciones

- **Límite de Tamaño**: Los documentos se truncan según `max_length`
- **Costo**: Se incluye en el cálculo de tokens normal del modelo
- **Tiempo de Proceso**: Documentos grandes pueden tomar más tiempo
- **Formato**: Algunos PDFs escaneados pueden no extraerse correctamente

¡La integración está completa y lista para usar! 🎉
